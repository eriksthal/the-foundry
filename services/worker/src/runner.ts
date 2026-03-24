import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CopilotClient } from "@github/copilot-sdk";
import { prisma, secrets as dbSecrets } from "@the-foundry/db";
import type { Project, Task } from "@the-foundry/db";
import { loadAgents } from "./agents/index.js";
import { buildMemoryContext } from "./memory.js";

export async function processTask(task: Task, project: Project): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), `foundry-${task.id}-`));

  try {
    const mask = (t?: string | null) => {
      if (!t) return '<missing>';
      if (t.length <= 8) return `${t.slice(0, 2)}...${t.slice(-2)}`;
      return `${t.slice(0, 4)}...${t.slice(-4)}`;
    };

    console.info('[runner] GITHUB_TOKEN present:', Boolean(process.env.GITHUB_TOKEN), 'value:', mask(process.env.GITHUB_TOKEN));
    console.info('[runner] COPILOT_GITHUB_TOKEN present:', Boolean(process.env.COPILOT_GITHUB_TOKEN), 'value:', mask(process.env.COPILOT_GITHUB_TOKEN));

    // 1. Clone the repository
    console.info(`[runner] Cloning ${project.repoUrl} into ${workDir}`);
    try {
      const out = execSync(
        `git clone --depth 1 --branch ${project.defaultBranch} ${project.repoUrl} .`,
        { cwd: workDir, stdio: "pipe", encoding: "utf8" }
      );
      if (out && out.length) console.info(`[runner] git clone stdout:\n${out}`);
    } catch (err) {
      console.error(`[runner] git clone failed for ${project.repoUrl} @ ${project.defaultBranch}:`, err instanceof Error ? err.message : String(err));
      throw err;
    }

    // 2. Create a working branch
    const branchName = `foundry/task-${task.id.slice(0, 8)}`;
    execSync(`git checkout -b ${branchName}`, { cwd: workDir, stdio: "pipe" });

    await prisma.task.update({
      where: { id: task.id },
      data: { branch: branchName },
    });

    // Repository setup: install dependencies and run build if present so tools are available
    try {
      const pkgPath = join(workDir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

        const hasPnpm = existsSync(join(workDir, "pnpm-lock.yaml"));
        const hasYarn = existsSync(join(workDir, "yarn.lock"));
        const hasPkgLock = existsSync(join(workDir, "package-lock.json"));

        let installCmd = "npm ci";
        if (hasPnpm) installCmd = "pnpm install --frozen-lockfile";
        else if (hasYarn) installCmd = "yarn install";
        else if (hasPkgLock) installCmd = "npm ci";
        else installCmd = "npm install";

        console.info(`[runner] Installing dependencies with: ${installCmd}`);
        try {
          const out = execSync(installCmd, { cwd: workDir, stdio: "pipe", encoding: "utf8", env: process.env });
          if (out && out.length) console.info(`[runner] install stdout:\n${out}`);
          await prisma.executionLog.create({ data: { taskId: task.id, event: "setup", result: `install:${installCmd}` } }).catch(() => {});
        } catch (e) {
          console.warn('[runner] Dependency install failed:', e instanceof Error ? e.message : String(e));
          await prisma.executionLog.create({ data: { taskId: task.id, event: 'setup_error', result: (e instanceof Error ? e.message : String(e)).slice(0, 2000) } }).catch(() => {});
        }

        // If the project has a build script, run it so compiled artifacts exist
        if (pkg && pkg.scripts && pkg.scripts.build) {
          try {
            const buildCmd = hasPnpm ? 'pnpm run build' : hasYarn ? 'yarn build' : 'npm run build';
            console.info(`[runner] Detected build script; running: ${buildCmd}`);
            const bout = execSync(buildCmd, { cwd: workDir, stdio: "pipe", encoding: "utf8", env: process.env });
            if (bout && bout.length) console.info(`[runner] build stdout:\n${bout}`);
            await prisma.executionLog.create({ data: { taskId: task.id, event: "setup", result: `build:${buildCmd}` } }).catch(() => {});
          } catch (e) {
            console.warn('[runner] Build failed:', e instanceof Error ? e.message : String(e));
            await prisma.executionLog.create({ data: { taskId: task.id, event: 'setup_error', result: (e instanceof Error ? e.message : String(e)).slice(0, 2000) } }).catch(() => {});
          }
        }
      } else {
        console.info('[runner] No package.json found; skipping dependency install.');
      }
    } catch (e) {
      console.warn('[runner] Repository setup step failed:', e instanceof Error ? e.message : String(e));
    }

    // 3. Load agent definitions and project memory
    const customAgents = loadAgents();
    const memoryContext = await buildMemoryContext(project.id);

    // Post-clone sanity check: ensure critical file exists and log its head if present
    const targetFile = join(workDir, "apps/admin/src/components/planning/wizard/autofill-batch-operations.ts");
    if (existsSync(targetFile)) {
      try {
        const head = readFileSync(targetFile, "utf8").split("\n").slice(0, 40).join("\n");
        console.info(`[runner] Target file present: ${targetFile}\n--- head ---\n${head}\n--- end head ---`);
      } catch (e) {
        console.warn(`[runner] Unable to read target file ${targetFile}:`, e instanceof Error ? e.message : String(e));
      }
    } else {
      console.warn(`[runner] Target file missing after clone: ${targetFile}`);
    }

    // Secrets injection: attempt to populate a .env in the work tree so the repo can run
    try {
      const parseGitUrl = (url: string) => {
        // support git@github.com:owner/repo.git and https://github.com/owner/repo.git
        try {
          if (!url) return { owner: undefined, name: undefined };
          const sshMatch = url.match(/^[^:]+:([^/]+)\/(.+?)($|\.git$)/);
          if (sshMatch) return { owner: sshMatch[1], name: sshMatch[2].replace(/\.git$/, "") };
          const httpsMatch = url.match(/github.com\/(.+?)\/(.+?)(?:$|\.git)/);
          if (httpsMatch) return { owner: httpsMatch[1], name: httpsMatch[2].replace(/\.git$/, "") };
        } catch {}
        return { owner: undefined, name: undefined };
      };

      const { owner, name } = parseGitUrl(project.repoUrl);

      const home = process.env.HOME || process.env.USERPROFILE || '';
      const candidatePaths = [] as string[];

      // Priority: env override
      if (process.env.FOUNDRY_SECRETS_FILE) candidatePaths.push(process.env.FOUNDRY_SECRETS_FILE);

      // Per-repo secrets
      if (home) {
        candidatePaths.push(join(home, '.foundry', 'secrets', `${owner || 'unknown'}__${name || 'repo'}.env`));
        candidatePaths.push(join(home, '.foundry', `${owner || 'unknown'}__${name || 'repo'}.env`));
        candidatePaths.push(join(home, '.foundry', 'secrets.env'));
        candidatePaths.push(join(home, '.foundry', 'secrets', 'secrets.env'));
      }

      // Repo-level template examples
      const repoExample = join(workDir, '.env.example');
      const repoTemplate = join(workDir, '.env.template');

      let secretsContent: string | undefined = undefined;

      // Try DB-backed secrets first (encrypted in Foundry DB)
      try {
        if (owner && name) {
          const s = await dbSecrets.getDecryptedSecret(owner, name);
          if (s) {
            secretsContent = s;
            console.info('[runner] Loaded secrets from DB for', `${owner}/${name}`);
            await prisma.executionLog.create({ data: { taskId: task.id, event: 'secrets_injection', result: `loaded:db:${owner}/${name}` } }).catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[runner] Failed to load secrets from DB:', e instanceof Error ? e.message : String(e));
      }

      for (const p of candidatePaths) {
        try {
          if (p && existsSync(p)) {
            secretsContent = readFileSync(p, 'utf8');
            console.info('[runner] Found secrets file at', p);
            await prisma.executionLog.create({ data: { taskId: task.id, event: 'secrets_injection', result: `loaded:${p}` } }).catch(() => {});
            break;
          }
        } catch (e) {
          /* ignore */
        }
      }

      // If we found a secrets source, write it to workDir/.env
      if (secretsContent) {
        try {
          const outPath = join(workDir, '.env');
          // If repo provides a .env.example, only inject keys present there
          if (existsSync(repoExample) || existsSync(repoTemplate)) {
            const examplePath = existsSync(repoExample) ? repoExample : repoTemplate;
            const exampleKeys = readFileSync(examplePath, 'utf8')
              .split('\n')
              .map((l) => l.split('=')[0].trim())
              .filter(Boolean);

            const kv = secretsContent.split('\n').map((l) => l.trim()).filter(Boolean);
            const filtered = kv.filter((line) => {
              const key = line.split('=')[0].trim();
              return exampleKeys.includes(key);
            });
            readFileSync;
            secretsContent = filtered.join('\n');
          }

          // write .env
          await (async () => {
            try {
              const fs = await import('node:fs');
              fs.writeFileSync(outPath, secretsContent || '', { encoding: 'utf8' });
            } catch (e) {
              // fallback
              require('fs').writeFileSync(outPath, secretsContent || '', 'utf8');
            }
          })();

          console.info('[runner] Wrote secrets to', join(workDir, '.env'));
          await prisma.executionLog.create({ data: { taskId: task.id, event: 'secrets_injection', result: `wrote:.env` } }).catch(() => {});
        } catch (e) {
          console.warn('[runner] Failed to write secrets to work dir:', e instanceof Error ? e.message : String(e));
        }
      } else {
        console.info('[runner] No local secrets file found; relying on environment variables only');
      }
    } catch (e) {
      console.warn('[runner] Secrets injection step failed:', e instanceof Error ? e.message : String(e));
    }

    // 4. Start Copilot session
    const client = new CopilotClient();
    const session = await client.createSession({
      model: "gpt-4.1",
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

    // 5. Subscribe to session events (subagent events, progress, logs)
    session.on((event: { type: string; data?: Record<string, unknown> }) => {
      try {
        // Log everything locally for debugging
        console.info('[runner][session.event]', event.type, event.data ?? {});

        // Persist useful events to execution log
        prisma.executionLog.create({
          data: {
            taskId: task.id,
            event: event.type,
            toolName: (event.data?.agentName as string) ?? undefined,
            result: event.data ? JSON.stringify(event.data).slice(0, 2000) : undefined,
          },
        }).catch(() => {
          /* best-effort logging */
        });

        // update task last activity timestamp so monitors can detect liveliness
        prisma.task
          .update({ where: { id: task.id }, data: { lastActivityAt: new Date() } })
          .catch(() => {
            /* ignore update errors */
          });
      } catch (e) {
        /* ignore logging errors */
      }
    });

    // 6. Single prompt → single premium request
    const prompt = buildTaskPrompt(task, branchName);
    console.info(`[runner] Sending prompt to Copilot...`);

    let response: any = undefined;
    // configurable timeout for Copilot session (ms)
    const timeoutMs = Number(process.env.WORKER_SESSION_TIMEOUT_MS) || 300_000; // default 5 minutes

    try {
      // Use a sliding timeout that resets on any session event so
      // an agent that is actively emitting events doesn't get killed.
      response = await (async () => {
        let timer: NodeJS.Timeout | null = null;
        let timeoutReject: ((e: Error) => void) | null = null;

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutReject = reject;
          timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms waiting for session.idle`)), timeoutMs);
        });

        const slidingListener = (event: { type: string }) => {
          try {
            // reset the timer whenever any event arrives
            if (timer) {
              clearTimeout(timer);
            }
            timer = setTimeout(() => {
              if (timeoutReject) timeoutReject(new Error(`Timeout after ${timeoutMs}ms waiting for session.idle`));
            }, timeoutMs);

            // update lastActivityAt so monitors see the activity
            prisma.task.update({ where: { id: task.id }, data: { lastActivityAt: new Date() } }).catch(() => {});
          } catch (e) {
            /* ignore */
          }
        };

        try {
          // attach a lightweight listener in addition to the primary session.on above
          if (typeof (session as any).on === 'function') {
            (session as any).on(slidingListener);
          }

          const p = session.sendAndWait({ prompt }, timeoutMs);

          // start the initial timer (already started by timeoutPromise)
          return await Promise.race([p, timeoutPromise]);
        } finally {
          if (timer) clearTimeout(timer);
          if (typeof (session as any).off === 'function') {
            try {
              (session as any).off(slidingListener);
            } catch {}
          }
        }
      })();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[runner] Copilot session error:', errMsg);

      // Persist session error to execution logs (mark time)
      try {
        await prisma.executionLog.create({
          data: {
            taskId: task.id,
            event: errMsg.includes('Timeout after') ? 'session_timeout' : 'session_error',
            result: errMsg.slice(0, 2000),
          },
        });
      } catch {}

      // Ensure task lastActivityAt is updated so monitors see recent activity
      try {
        await prisma.task.update({ where: { id: task.id }, data: { lastActivityAt: new Date() } });
      } catch {}

      // Attempt to snapshot any partial transcript or state if available on session
      try {
        if (typeof (session as any).getTranscript === 'function') {
          const transcript = await (session as any).getTranscript();
          console.info('[runner] Session transcript snapshot:', transcript);
          await prisma.executionLog.create({
            data: {
              taskId: task.id,
              event: 'session_transcript',
              result: JSON.stringify(transcript).slice(0, 2000),
            },
          });
        }
      } catch (e) {
        /* ignore */
      }

      // Try to terminate the session cleanly so background agents stop running
      try {
        if (typeof (session as any).cancel === 'function') {
          await (session as any).cancel();
          console.info('[runner] Called session.cancel() after error');
        } else if (typeof (session as any).close === 'function') {
          await (session as any).close();
          console.info('[runner] Called session.close() after error');
        }
      } catch (e) {
        console.warn('[runner] Failed to terminate session after error:', e instanceof Error ? e.message : String(e));
      }

      // Ensure the client is stopped to release any resources
      try {
        await client.stop();
      } catch (e) {
        console.warn('[runner] Failed to stop Copilot client after error:', e instanceof Error ? e.message : String(e));
      }

      // Rethrow to mark task failed and trigger retry logic
      throw err;
    }

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
