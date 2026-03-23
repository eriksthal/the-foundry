import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CopilotClient } from "@github/copilot-sdk";
import { prisma } from "@the-foundry/db";
import type { Project, Task } from "@the-foundry/db";
import { loadAgents } from "./agents/index.js";
import { buildMemoryContext } from "./memory.js";

export async function processTask(task: Task, project: Project): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), `foundry-${task.id}-`));

  try {
    // 1. Clone the repository
    console.info(`[runner] Cloning ${project.repoUrl} into ${workDir}`);
    execSync(`git clone --depth 1 --branch ${project.defaultBranch} ${project.repoUrl} .`, {
      cwd: workDir,
      stdio: "pipe",
    });

    // 2. Create a working branch
    const branchName = `foundry/task-${task.id.slice(0, 8)}`;
    execSync(`git checkout -b ${branchName}`, { cwd: workDir, stdio: "pipe" });

    await prisma.task.update({
      where: { id: task.id },
      data: { branch: branchName },
    });

    // 3. Load agent definitions and project memory
    const customAgents = loadAgents();
    const memoryContext = await buildMemoryContext(project.id);

    // 4. Start Copilot session
    const client = new CopilotClient();
    const session = await client.createSession({
      model: "claude-sonnet-4",
      agent: "orchestrator",
      customAgents,
      workingDirectory: workDir,
      hooks: {
        onSessionStart: async () => ({
          additionalContext: [
            `Repository: ${project.repoUrl}`,
            `Branch: ${branchName}`,
            `Working directory: ${workDir}`,
            memoryContext,
          ]
            .filter(Boolean)
            .join("\n\n"),
        }),
        onPreToolUse: async (input: { toolName: string; toolArgs: unknown }) => {
          await prisma.executionLog.create({
            data: {
              taskId: task.id,
              event: "tool_call",
              toolName: input.toolName,
              toolArgs: input.toolArgs ? JSON.parse(JSON.stringify(input.toolArgs)) : undefined,
            },
          });
          return { permissionDecision: "allow" as const };
        },
        onPostToolUse: async (input: { toolName: string; toolResult: unknown }) => {
          await prisma.executionLog.create({
            data: {
              taskId: task.id,
              event: "tool_result",
              toolName: input.toolName,
              result:
                typeof input.toolResult === "string"
                  ? input.toolResult.slice(0, 2000)
                  : JSON.stringify(input.toolResult).slice(0, 2000),
            },
          });
          return undefined;
        },
      },
      onPermissionRequest: async () => ({ kind: "approved" as const }),
    });

    // 5. Subscribe to sub-agent events
    session.on((event: { type: string; data?: Record<string, unknown> }) => {
      if (event.type.startsWith("subagent.")) {
        prisma.executionLog
          .create({
            data: {
              taskId: task.id,
              event: event.type,
              toolName: (event.data?.agentName as string) ?? undefined,
            },
          })
          .catch(() => {
            /* best-effort logging */
          });
      }
    });

    // 6. Single prompt → single premium request
    const prompt = buildTaskPrompt(task, branchName);
    console.info(`[runner] Sending prompt to Copilot...`);

    const response = await session.sendAndWait({ prompt });

    // 7. Store result
    const resultContent = response?.data?.content ?? "No response content";
    await prisma.task.update({
      where: { id: task.id },
      data: { result: resultContent },
    });

    await client.stop();

    console.info(`[runner] Task ${task.id} completed. Branch: ${branchName}`);
  } finally {
    // Clean up temp directory
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      console.warn(`[runner] Failed to clean up ${workDir}`);
    }
  }
}

function buildTaskPrompt(task: Task, branchName: string): string {
  return `Execute the following task on this repository.

## Task
**Title:** ${task.title}

**Description:**
${task.description}

## Instructions
1. Analyze the codebase to understand the relevant code, structure, and conventions.
2. Plan the implementation with specific files and changes.
3. Implement the changes following existing patterns and conventions.
4. Run any existing tests or linters to verify the changes.
5. Review the changes for correctness, security, and quality.
6. Commit all changes with a clear, descriptive commit message.
7. Push the branch \`${branchName}\` to the remote.

## Constraints
- Follow existing code conventions found in the repository.
- Read any copilot-instructions.md or CONTRIBUTING.md in the repo before making changes.
- Make minimal, targeted changes. Do not refactor unrelated code.
- If tests exist, ensure they pass after your changes.
- If the task cannot be completed, explain why clearly.`;
}
