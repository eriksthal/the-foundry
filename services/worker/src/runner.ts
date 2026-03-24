import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CopilotClient } from "@github/copilot-sdk";
import {
  PlanApprovalStatus,
  prisma,
  TaskPhase,
  TaskScenario,
  TaskStatus,
  type ExecutionLog,
  type Project,
  type Task,
  secrets as dbSecrets,
} from "@the-foundry/db";
import { loadAgents } from "./agents/index.js";
import {
  ensureCommittedChanges,
  findOrCreatePullRequest,
  getGitStatusSummary,
  parseGitHubRepoUrl,
  pushBranchToOrigin,
} from "./github.js";
import { buildMemoryContext } from "./memory.js";
import {
  buildInitialTaskPrompt,
  buildResumePrompt,
  parseOrchestratorResponse,
  planApprovalStatusForScenario,
  type OrchestratorResponse,
} from "./orchestration.js";

export type ProcessTaskOutcome = "completed" | "awaiting_plan_approval";

const DEFAULT_TIMEOUT_MS = Number(process.env.WORKER_SESSION_TIMEOUT_MS) || 1_800_000;

export async function processTask(task: Task, project: Project): Promise<ProcessTaskOutcome> {
  const isResume =
    task.phase === TaskPhase.WAITING_FOR_PLAN_APPROVAL &&
    task.planApprovalStatus === PlanApprovalStatus.APPROVED &&
    Boolean(task.copilotSessionId) &&
    Boolean(task.workingDirectory);
  const workDir = isResume
    ? task.workingDirectory!
    : mkdtempSync(join(tmpdir(), `foundry-${task.id}-`));

  let preserveWorkDir = false;
  const client = new CopilotClient();

  try {
    logTokenPresence();

    let branchName = task.branch ?? `foundry/task-${task.id.slice(0, 8)}`;
    const sessionId = task.copilotSessionId ?? randomUUID();

    if (!isResume) {
      await prepareRepository(task, project, workDir, branchName);
    } else {
      console.info(`[runner] Resuming task ${task.id} in ${workDir}`);
      await prisma.task.update({
        where: { id: task.id },
        data: {
          status: TaskStatus.IN_PROGRESS,
          phase: TaskPhase.IMPLEMENT,
          lastActivityAt: new Date(),
        },
      });
    }

    const customAgents = loadAgents();
    const memoryContext = await buildMemoryContext(project.id);
    const hooks = buildHooks(task.id);
    const sessionConfig = {
      sessionId,
      model: "gpt-4.1",
      agent: "orchestrator",
      customAgents,
      workingDirectory: workDir,
      streaming: true,
      infiniteSessions: { enabled: true },
      hooks,
      onPermissionRequest: async () => ({ kind: "approved" as const }),
      onEvent: (event: { type: string; data?: Record<string, unknown> }) => {
        void persistSessionEvent(task.id, event);
      },
    };

    const session = isResume
      ? await client.resumeSession(task.copilotSessionId!, sessionConfig)
      : await client.createSession({
          ...sessionConfig,
          hooks: {
            ...hooks,
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
          },
        });

    await prisma.task.update({
      where: { id: task.id },
      data: {
        branch: branchName,
        copilotSessionId: sessionId,
        copilotWorkspacePath:
          task.copilotWorkspacePath ?? session.workspacePath ?? undefined,
        workingDirectory: workDir,
      },
    });

    const prompt = isResume ? buildResumePrompt(task) : buildInitialTaskPrompt(task, branchName);
    console.info(`[runner] Sending prompt to Copilot for task ${task.id}`);

    const response = await sendAndWaitWithSlidingTimeout(session, prompt, task.id);
    const resultContent = response?.data?.content ?? "No response content";
    const parsed = parseOrchestratorResponse(resultContent);
    const prInfo =
      parsed.action === "COMPLETE"
        ? await finalizePullRequest(task, project, workDir, branchName, parsed.prUrl)
        : null;

    const outcome = await applyOrchestrationResult(task.id, parsed, {
      sessionId,
      workspacePath: session.workspacePath,
      workDir,
      branchName,
      prUrl: prInfo?.url,
      rawContent: resultContent,
    });

    if (outcome === "awaiting_plan_approval") {
      preserveWorkDir = true;
      await session.disconnect();
      await client.stop();
      return outcome;
    }

    await prisma.task.update({
      where: { id: task.id },
      data: {
        result: parsed.finalSummary,
        prUrl: prInfo?.url,
        phase: TaskPhase.DONE,
        lastActivityAt: new Date(),
      },
    });

    await client.stop();

    console.info(`[runner] Task ${task.id} completed. Branch: ${branchName}`);
    return "completed";
  } finally {
    if (!preserveWorkDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        console.warn(`[runner] Failed to clean up ${workDir}`);
      }
    }
  }
}

async function prepareRepository(
  task: Task,
  project: Project,
  workDir: string,
  branchName: string,
): Promise<void> {
  console.info(`[runner] Cloning ${project.repoUrl} into ${workDir}`);
  try {
    const out = execSync(
      `git clone --depth 1 --branch ${project.defaultBranch} ${project.repoUrl} .`,
      { cwd: workDir, stdio: "pipe", encoding: "utf8" },
    );
    if (out) console.info(`[runner] git clone stdout:\n${out}`);
  } catch (err) {
    console.error(
      `[runner] git clone failed for ${project.repoUrl} @ ${project.defaultBranch}:`,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }

  execSync(`git checkout -b ${branchName}`, { cwd: workDir, stdio: "pipe" });

  await prisma.task.update({
    where: { id: task.id },
    data: {
      branch: branchName,
      phase: TaskPhase.CLASSIFY,
      planApprovalStatus: PlanApprovalStatus.NOT_REQUIRED,
      lastActivityAt: new Date(),
      workingDirectory: workDir,
    },
  });

  await setupRepository(task.id, workDir);
  await injectSecrets(task.id, project.repoUrl, workDir);
}

async function setupRepository(taskId: string, workDir: string): Promise<void> {
  try {
    const pkgPath = join(workDir, "package.json");
    if (!existsSync(pkgPath)) {
      console.info("[runner] No package.json found; skipping dependency install.");
      return;
    }

    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const hasPnpm = existsSync(join(workDir, "pnpm-lock.yaml"));
    const hasYarn = existsSync(join(workDir, "yarn.lock"));
    const hasPkgLock = existsSync(join(workDir, "package-lock.json"));

    let installCmd = "npm ci";
    if (hasPnpm) installCmd = "pnpm install --frozen-lockfile";
    else if (hasYarn) installCmd = "yarn install";
    else if (!hasPkgLock) installCmd = "npm install";

    console.info(`[runner] Installing dependencies with: ${installCmd}`);
    try {
      const out = execSync(installCmd, {
        cwd: workDir,
        stdio: "pipe",
        encoding: "utf8",
        env: process.env,
      });
      if (out) console.info(`[runner] install stdout:\n${out}`);
      await createLog(taskId, { event: "setup", result: `install:${installCmd}` });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn("[runner] Dependency install failed:", message);
      await createLog(taskId, { event: "setup_error", result: message.slice(0, 2000) });
    }

    if (pkg?.scripts?.build) {
      try {
        const buildCmd = hasPnpm ? "pnpm run build" : hasYarn ? "yarn build" : "npm run build";
        console.info(`[runner] Detected build script; running: ${buildCmd}`);
        const out = execSync(buildCmd, {
          cwd: workDir,
          stdio: "pipe",
          encoding: "utf8",
          env: process.env,
        });
        if (out) console.info(`[runner] build stdout:\n${out}`);
        await createLog(taskId, { event: "setup", result: `build:${buildCmd}` });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn("[runner] Build failed:", message);
        await createLog(taskId, { event: "setup_error", result: message.slice(0, 2000) });
      }
    }
  } catch (e) {
    console.warn(
      "[runner] Repository setup step failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

async function injectSecrets(taskId: string, repoUrl: string, workDir: string): Promise<void> {
  try {
    const { owner, name } = parseGitUrl(repoUrl);
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const candidatePaths: string[] = [];

    if (process.env.FOUNDRY_SECRETS_FILE) candidatePaths.push(process.env.FOUNDRY_SECRETS_FILE);

    if (home) {
      candidatePaths.push(join(home, ".foundry", "secrets", `${owner || "unknown"}__${name || "repo"}.env`));
      candidatePaths.push(join(home, ".foundry", `${owner || "unknown"}__${name || "repo"}.env`));
      candidatePaths.push(join(home, ".foundry", "secrets.env"));
      candidatePaths.push(join(home, ".foundry", "secrets", "secrets.env"));
    }

    const repoExample = join(workDir, ".env.example");
    const repoTemplate = join(workDir, ".env.template");

    let secretsContent: string | undefined;

    try {
      if (owner && name) {
        const secret = await dbSecrets.getDecryptedSecret(owner, name);
        if (secret) {
          secretsContent = secret;
          await createLog(taskId, {
            event: "secrets_injection",
            result: `loaded:db:${owner}/${name}`,
          });
        }
      }
    } catch (e) {
      console.warn("[runner] Failed to load secrets from DB:", e instanceof Error ? e.message : String(e));
    }

    for (const candidate of candidatePaths) {
      if (!candidate || !existsSync(candidate)) continue;
      secretsContent = readFileSync(candidate, "utf8");
      await createLog(taskId, {
        event: "secrets_injection",
        result: `loaded:${candidate}`,
      });
      break;
    }

    if (!secretsContent) {
      console.info("[runner] No local secrets file found; relying on environment variables only");
      return;
    }

    const outPath = join(workDir, ".env");
    if (existsSync(repoExample) || existsSync(repoTemplate)) {
      const examplePath = existsSync(repoExample) ? repoExample : repoTemplate;
      const exampleKeys = readFileSync(examplePath, "utf8")
        .split("\n")
        .map((line) => line.split("=")[0]?.trim())
        .filter(Boolean);

      secretsContent = secretsContent
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => exampleKeys.includes(line.split("=")[0]?.trim()))
        .join("\n");
    }

    writeFileSync(outPath, secretsContent, "utf8");
    await createLog(taskId, { event: "secrets_injection", result: "wrote:.env" });
  } catch (e) {
    console.warn(
      "[runner] Secrets injection step failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

function buildHooks(taskId: string) {
  return {
    onPreToolUse: async (input: { toolName: string; toolArgs: unknown }) => {
      await createLog(taskId, {
        event: "tool_call",
        toolName: input.toolName,
        toolArgs: input.toolArgs ? JSON.parse(JSON.stringify(input.toolArgs)) : undefined,
      });
      return { permissionDecision: "allow" as const };
    },
    onPostToolUse: async (input: { toolName: string; toolResult: unknown }) => {
      await createLog(taskId, {
        event: "tool_result",
        toolName: input.toolName,
        payload: input.toolResult ? JSON.parse(JSON.stringify(input.toolResult)) : undefined,
        result:
          typeof input.toolResult === "string"
            ? input.toolResult.slice(0, 2000)
            : JSON.stringify(input.toolResult).slice(0, 2000),
      });
      return undefined;
    },
  };
}

async function sendAndWaitWithSlidingTimeout(
  session: {
    sendAndWait: (options: { prompt: string }, timeoutMs?: number) => Promise<any>;
    on: (handler: (event: { type: string }) => void) => (() => void) | void;
  },
  prompt: string,
  taskId: string,
): Promise<any> {
  let timer: NodeJS.Timeout | null = null;
  let timeoutReject: ((error: Error) => void) | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutReject = reject;
    timer = setTimeout(
      () => reject(new Error(`Timeout after ${DEFAULT_TIMEOUT_MS}ms waiting for session.idle`)),
      DEFAULT_TIMEOUT_MS,
    );
  });

  const resetTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (timeoutReject) {
        timeoutReject(new Error(`Timeout after ${DEFAULT_TIMEOUT_MS}ms waiting for session.idle`));
      }
    }, DEFAULT_TIMEOUT_MS);
    void prisma.task.update({
      where: { id: taskId },
      data: { lastActivityAt: new Date() },
    }).catch(() => {});
  };

  const unsubscribe = session.on(() => {
    resetTimer();
  });

  try {
    return await Promise.race([session.sendAndWait({ prompt }, DEFAULT_TIMEOUT_MS), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (typeof unsubscribe === "function") unsubscribe();
  }
}

async function applyOrchestrationResult(
  taskId: string,
  response: OrchestratorResponse,
  context: {
    sessionId: string;
    workspacePath?: string;
    workDir: string;
    branchName: string;
    prUrl?: string;
    rawContent: string;
  },
): Promise<ProcessTaskOutcome> {
  await createLog(taskId, {
    event: "classification.completed",
    phase: TaskPhase.CLASSIFY,
    result: response.classification.reason.slice(0, 2000),
    payload: response.classification,
  });

  const planApprovalStatus = planApprovalStatusForScenario(response.scenario, response.action);
  const updateData = {
    scenario: TaskScenario[response.scenario],
    phase: TaskPhase[response.phase],
    classificationReason: response.classification.reason,
    riskLevel: response.classification.riskLevel,
    estimatedTracks: response.classification.estimatedTracks,
    planApprovalStatus: PlanApprovalStatus[planApprovalStatus],
    planContent: response.plan ? JSON.parse(JSON.stringify(response.plan)) : undefined,
    result: response.finalSummary,
    prUrl: context.prUrl,
    copilotSessionId: context.sessionId,
    copilotWorkspacePath: context.workspacePath ?? undefined,
    workingDirectory: context.workDir,
    branch: context.branchName,
    lastActivityAt: new Date(),
  } satisfies Partial<Task>;

  if (response.plan) {
    await createLog(taskId, {
      event: "plan.generated",
      phase:
        response.action === "AWAIT_PLAN_APPROVAL"
          ? TaskPhase.PLAN_DRAFT
          : response.scenario === "MEDIUM"
            ? TaskPhase.PLAN
            : response.phase === "PLAN_DRAFT"
              ? TaskPhase.PLAN_DRAFT
              : undefined,
      result: response.plan.summary.slice(0, 2000),
      payload: response.plan,
    });
  }

  if (response.action === "AWAIT_PLAN_APPROVAL") {
    await prisma.task.update({
      where: { id: taskId },
      data: {
        ...updateData,
        status: TaskStatus.WAITING_FOR_PLAN_APPROVAL,
        phase: TaskPhase.WAITING_FOR_PLAN_APPROVAL,
      },
    });

    await createLog(taskId, {
      event: "plan.awaiting_approval",
      phase: TaskPhase.WAITING_FOR_PLAN_APPROVAL,
      result: response.finalSummary.slice(0, 2000),
      payload: {
        scenario: response.scenario,
        rawContent: context.rawContent,
      },
    });

    return "awaiting_plan_approval";
  }

  if (response.action === "FAIL") {
    await prisma.task.update({
      where: { id: taskId },
      data: {
        ...updateData,
        status: TaskStatus.FAILED,
        phase: TaskPhase.FAILED,
        errorLog: response.finalSummary,
      },
    });
    throw new Error(response.finalSummary);
  }

  if (response.review) {
    await createLog(taskId, {
      event: "review.completed",
      phase: TaskPhase.REVIEW,
      result: response.review.summary.slice(0, 2000),
      payload: response.review,
    });
  }

  await prisma.task.update({
    where: { id: taskId },
    data: {
      ...updateData,
      status: TaskStatus.IN_PROGRESS,
      phase: TaskPhase.DONE,
      planApprovalStatus: response.scenario === "COMPLEX"
        ? PlanApprovalStatus.APPROVED
        : PlanApprovalStatus.NOT_REQUIRED,
    },
  });

  return "completed";
}

async function persistSessionEvent(
  taskId: string,
  event: { type: string; data?: Record<string, unknown> },
): Promise<void> {
  try {
    console.info("[runner][session.event]", event.type, event.data ?? {});

    await createLog(taskId, {
      event: event.type,
      agentName: typeof event.data?.agentName === "string" ? event.data.agentName : undefined,
      payload: event.data ? JSON.parse(JSON.stringify(event.data)) : undefined,
      result: event.data ? JSON.stringify(event.data).slice(0, 2000) : undefined,
    });

    await prisma.task.update({
      where: { id: taskId },
      data: { lastActivityAt: new Date() },
    }).catch(() => {});
  } catch {
    // best-effort logging
  }
}

async function createLog(
  taskId: string,
  data: Omit<Partial<ExecutionLog>, "id" | "taskId" | "timestamp"> & { event: string },
): Promise<void> {
  await prisma.executionLog.create({
    data: {
      taskId,
      event: data.event,
      phase: data.phase,
      agentName: data.agentName,
      toolName: data.toolName,
      toolArgs: data.toolArgs ? JSON.parse(JSON.stringify(data.toolArgs)) : undefined,
      payload: data.payload ? JSON.parse(JSON.stringify(data.payload)) : undefined,
      result: data.result,
    },
  }).catch(() => {});
}

function parseGitUrl(url: string): { owner?: string; name?: string } {
  if (!url) return {};
  const repo = parseGitHubRepoUrl(url);
  if (repo) return { owner: repo.owner, name: repo.repo };
  return {};
}

function logTokenPresence(): void {
  const mask = (token?: string | null) => {
    if (!token) return "<missing>";
    if (token.length <= 8) return `${token.slice(0, 2)}...${token.slice(-2)}`;
    return `${token.slice(0, 4)}...${token.slice(-4)}`;
  };

  console.info("[runner] GITHUB_TOKEN present:", Boolean(process.env.GITHUB_TOKEN), "value:", mask(process.env.GITHUB_TOKEN));
  console.info(
    "[runner] COPILOT_GITHUB_TOKEN present:",
    Boolean(process.env.COPILOT_GITHUB_TOKEN),
    "value:",
    mask(process.env.COPILOT_GITHUB_TOKEN),
  );
}

async function finalizePullRequest(
  task: Task,
  project: Project,
  workDir: string,
  branchName: string,
  reportedPrUrl?: string,
): Promise<{ url: string } | null> {
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  const repoRef = parseGitHubRepoUrl(project.repoUrl);

  if (!githubToken) {
    await createLog(task.id, {
      event: "pr.skipped",
      phase: TaskPhase.CREATE_PR,
      result: "Missing GITHUB_TOKEN; skipping PR creation.",
    });
    return null;
  }

  if (!repoRef) {
    await createLog(task.id, {
      event: "pr.skipped",
      phase: TaskPhase.CREATE_PR,
      result: `Unsupported repository URL: ${project.repoUrl}`,
    });
    return null;
  }

  const hadLocalChanges = ensureCommittedChanges(workDir, task.title);
  if (hadLocalChanges) {
    await createLog(task.id, {
      event: "git.commit",
      phase: TaskPhase.CREATE_PR,
      result: `Committed local changes on ${branchName}.`,
    });
  }

  const gitStatus = getGitStatusSummary(workDir);
  const needsPush = hadLocalChanges || gitStatus.commitsAheadOfBase > 0 || !gitStatus.branchExistsOnRemote;

  if (!needsPush) {
    const existingPr = await findOrCreatePullRequest({
      task,
      project,
      branchName,
      reportedPrUrl,
    });

    if (existingPr && reportedPrUrl && existingPr.url !== reportedPrUrl) {
      await createLog(task.id, {
        event: "pr.reported_url_mismatch",
        phase: TaskPhase.CREATE_PR,
        result: `Ignoring reported PR URL ${reportedPrUrl} in favor of ${existingPr.url}.`,
      });
    }

    if (existingPr) {
      await createLog(task.id, {
        event: "pr.synced",
        phase: TaskPhase.CREATE_PR,
        result: existingPr.url,
      });
      return { url: existingPr.url };
    }

    return null;
  }

  pushBranchToOrigin(workDir, branchName, githubToken);
  await createLog(task.id, {
    event: "git.push",
    phase: TaskPhase.CREATE_PR,
    result: `Pushed branch ${branchName} to origin.`,
  });

  const pr = await findOrCreatePullRequest({
    task,
    project,
    branchName,
    reportedPrUrl,
  });

  if (!pr) {
    await createLog(task.id, {
      event: "pr.unavailable",
      phase: TaskPhase.CREATE_PR,
      result: "Push succeeded but no PR could be found or created.",
    });
    return null;
  }

  if (reportedPrUrl && pr.url !== reportedPrUrl) {
    await createLog(task.id, {
      event: "pr.reported_url_mismatch",
      phase: TaskPhase.CREATE_PR,
      result: `Ignoring reported PR URL ${reportedPrUrl} in favor of ${pr.url}.`,
    });
  }

  await createLog(task.id, {
    event: "pr.synced",
    phase: TaskPhase.CREATE_PR,
    result: pr.url,
  });

  return { url: pr.url };
}
