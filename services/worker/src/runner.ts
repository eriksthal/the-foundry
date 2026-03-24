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
type ExecutionMode = "fresh" | "resume_approved_plan" | "restart_from_approved_plan";
type ExecutionEvidence = {
  editToolCalls: number;
  writeToolCalls: number;
  reviewCompleted: boolean;
};

const DEFAULT_TIMEOUT_MS = Number(process.env.WORKER_SESSION_TIMEOUT_MS) || 1_800_000;

export async function processTask(task: Task, project: Project): Promise<ProcessTaskOutcome> {
  const executionMode = determineExecutionMode(task);
  let activeWorkDir =
    executionMode === "resume_approved_plan"
      ? task.workingDirectory!
      : mkdtempSync(join(tmpdir(), `foundry-${task.id}-`));
  let activeExecutionMode = executionMode;

  let preserveWorkDir = false;
  const client = new CopilotClient();

  try {
    logTokenPresence();

    let branchName = task.branch ?? `foundry/task-${task.id.slice(0, 8)}`;
    const initialSessionId =
      executionMode === "resume_approved_plan" && task.copilotSessionId
        ? task.copilotSessionId
        : randomUUID();

    await prepareTaskWorkspace(task, project, activeWorkDir, branchName, executionMode);

    const customAgents = loadAgents();
    const memoryContext = await buildMemoryContext(project.id);
    const evidence = createExecutionEvidence();
    const hooks = buildHooks(task.id, evidence);
    const sessionConfig = {
      sessionId: initialSessionId,
      model: "gpt-4.1",
      agent: "orchestrator",
      customAgents,
      workingDirectory: activeWorkDir,
      streaming: true,
      infiniteSessions: { enabled: true },
      hooks,
      onPermissionRequest: async () => ({ kind: "approved" as const }),
      onEvent: (event: { type: string; data?: Record<string, unknown> }) => {
        void persistSessionEvent(task.id, event);
      },
    };

    const sessionState = await createCopilotSession(client, {
      task,
      project,
      branchName,
      workDir: activeWorkDir,
      memoryContext,
      sessionId: initialSessionId,
      sessionConfig,
      executionMode,
    });
    const { session } = sessionState;
    activeWorkDir = sessionState.workDir;
    activeExecutionMode = sessionState.executionMode;

    await prisma.task.update({
      where: { id: task.id },
      data: {
        branch: branchName,
        copilotSessionId: sessionState.sessionId,
        copilotWorkspacePath:
          activeExecutionMode === "resume_approved_plan"
            ? task.copilotWorkspacePath ?? session.workspacePath ?? undefined
            : session.workspacePath ?? task.copilotWorkspacePath ?? undefined,
        workingDirectory: activeWorkDir,
      },
    });

    const prompt =
      activeExecutionMode === "fresh"
        ? buildInitialTaskPrompt(task, branchName)
        : buildResumePrompt(task);
    console.info(`[runner] Sending prompt to Copilot for task ${task.id}`);

    const executionResult = await executeTaskWithGuards({
      session,
      task,
      project,
      prompt,
      evidence,
      workDir: activeWorkDir,
    });
    const { parsed, resultContent, evidenceFailureReason } = executionResult;
    const prInfo =
      parsed.action === "COMPLETE"
        ? await finalizePullRequest(task, project, activeWorkDir, branchName, parsed.prUrl)
        : null;

    if (parsed.action === "COMPLETE" && isPullRequestRequired() && !prInfo?.url) {
      throw new Error(
        prInfo?.error ??
          evidenceFailureReason ??
          "Task completed without an associated pull request.",
      );
    }

    const outcome = await applyOrchestrationResult(task.id, parsed, {
      sessionId: sessionState.sessionId,
      workspacePath: session.workspacePath,
      workDir: activeWorkDir,
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
        rmSync(activeWorkDir, { recursive: true, force: true });
      } catch {
        console.warn(`[runner] Failed to clean up ${activeWorkDir}`);
      }
    }
  }
}

async function prepareRepository(
  task: Task,
  project: Project,
  workDir: string,
  branchName: string,
  options?: {
    phase?: TaskPhase;
    planApprovalStatus?: PlanApprovalStatus;
  },
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
      phase: options?.phase ?? TaskPhase.CLASSIFY,
      planApprovalStatus: options?.planApprovalStatus ?? PlanApprovalStatus.NOT_REQUIRED,
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

    const shouldRunSetupBuild = process.env.FOUNDRY_SETUP_RUN_BUILD?.trim().toLowerCase() === "true";

    if (pkg?.scripts?.build && shouldRunSetupBuild) {
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
    } else if (pkg?.scripts?.build) {
      console.info(
        "[runner] Skipping automatic setup build. Set FOUNDRY_SETUP_RUN_BUILD=true to enable it.",
      );
      await createLog(taskId, {
        event: "setup",
        result: "build:skipped (set FOUNDRY_SETUP_RUN_BUILD=true to enable)",
      });
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

function buildHooks(taskId: string, evidence: ExecutionEvidence) {
  return {
    onPreToolUse: async (input: { toolName: string; toolArgs: unknown }) => {
      if (input.toolName === "edit_file") evidence.editToolCalls += 1;
      if (input.toolName === "write_file") evidence.writeToolCalls += 1;
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

  if (response.action !== "COMPLETE") {
    await prisma.task.update({
      where: { id: taskId },
      data: {
        ...updateData,
        status: TaskStatus.FAILED,
        phase: TaskPhase.FAILED,
        errorLog: `Unsupported orchestrator action: ${response.action}`,
      },
    });
    throw new Error(`Unsupported orchestrator action: ${response.action}`);
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

function determineExecutionMode(task: Task): ExecutionMode {
  const approvedPlanReady =
    task.phase === TaskPhase.WAITING_FOR_PLAN_APPROVAL &&
    task.planApprovalStatus === PlanApprovalStatus.APPROVED;

  if (!approvedPlanReady) return "fresh";

  if (task.copilotSessionId && task.workingDirectory) return "resume_approved_plan";

  return "restart_from_approved_plan";
}

async function prepareTaskWorkspace(
  task: Task,
  project: Project,
  workDir: string,
  branchName: string,
  executionMode: ExecutionMode,
): Promise<void> {
  if (executionMode === "resume_approved_plan") {
    console.info(`[runner] Resuming approved plan for task ${task.id} in ${workDir}`);
    await createLog(task.id, {
      event: "plan.resume",
      phase: TaskPhase.IMPLEMENT,
      result: `Resuming approved plan in existing workspace ${workDir}.`,
    });
    await prisma.task.update({
      where: { id: task.id },
      data: {
        status: TaskStatus.IN_PROGRESS,
        phase: TaskPhase.IMPLEMENT,
        errorLog: null,
        lastActivityAt: new Date(),
      },
    });
    return;
  }

  if (executionMode === "restart_from_approved_plan") {
    console.info(`[runner] Restarting approved plan for task ${task.id} with a fresh workspace`);
    await createLog(task.id, {
      event: "plan.resume_fallback",
      phase: TaskPhase.IMPLEMENT,
      result:
        "Previous approved-plan session could not be resumed. Starting a fresh session with the approved plan.",
    });
    await prisma.task.update({
      where: { id: task.id },
      data: {
        status: TaskStatus.IN_PROGRESS,
        phase: TaskPhase.IMPLEMENT,
        errorLog: null,
        lastActivityAt: new Date(),
      },
    });
    await prepareRepository(task, project, workDir, branchName, {
      phase: TaskPhase.IMPLEMENT,
      planApprovalStatus: PlanApprovalStatus.APPROVED,
    });
    return;
  }

  await prepareRepository(task, project, workDir, branchName);
}

async function createCopilotSession(
  client: CopilotClient,
  params: {
    task: Task;
    project: Project;
    branchName: string;
    workDir: string;
    memoryContext: string;
    sessionId: string;
    sessionConfig: {
      sessionId: string;
      model: string;
      agent: string;
      customAgents: ReturnType<typeof loadAgents>;
      workingDirectory: string;
      streaming: boolean;
      infiniteSessions: { enabled: boolean };
      hooks: ReturnType<typeof buildHooks>;
      onPermissionRequest: () => Promise<{ kind: "approved" }>;
      onEvent: (event: { type: string; data?: Record<string, unknown> }) => void;
    };
    executionMode: ExecutionMode;
  },
): Promise<{
  session: Awaited<ReturnType<CopilotClient["createSession"]>>;
  sessionId: string;
  workDir: string;
  executionMode: ExecutionMode;
}> {
  const { task, project, branchName, workDir, memoryContext, sessionId, sessionConfig, executionMode } =
    params;

  if (executionMode === "resume_approved_plan" && task.copilotSessionId) {
    try {
      const session = await client.resumeSession(task.copilotSessionId, sessionConfig);
      return {
        session,
        sessionId: task.copilotSessionId,
        workDir,
        executionMode,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await createLog(task.id, {
        event: "plan.resume_failed",
        phase: TaskPhase.IMPLEMENT,
        result: `Could not resume prior approved-plan session. ${message}`,
      });

      const fallbackWorkDir = mkdtempSync(join(tmpdir(), `foundry-${task.id}-resume-fallback-`));
      await prepareTaskWorkspace(task, project, fallbackWorkDir, branchName, "restart_from_approved_plan");
      const fallbackSessionId = randomUUID();

      const session = await client.createSession({
        ...sessionConfig,
        sessionId: fallbackSessionId,
        workingDirectory: fallbackWorkDir,
        hooks: {
          ...sessionConfig.hooks,
          onSessionStart: async () => ({
            additionalContext: [
              `Repository: ${project.repoUrl}`,
              `Branch: ${branchName}`,
              `Working directory: ${fallbackWorkDir}`,
              memoryContext,
            ]
              .filter(Boolean)
              .join("\n\n"),
          }),
        },
      });
      return {
        session,
        sessionId: fallbackSessionId,
        workDir: fallbackWorkDir,
        executionMode: "restart_from_approved_plan",
      };
    }
  }

  const session = await client.createSession({
    ...sessionConfig,
    sessionId,
    hooks: {
      ...sessionConfig.hooks,
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
  return {
    session,
    sessionId,
    workDir,
    executionMode,
  };
}

async function finalizePullRequest(
  task: Task,
  project: Project,
  workDir: string,
  branchName: string,
  reportedPrUrl?: string,
): Promise<{ url?: string; error?: string } | null> {
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  const repoRef = parseGitHubRepoUrl(project.repoUrl);

  if (!githubToken) {
    const error = "Missing GITHUB_TOKEN; skipping PR creation.";
    await createLog(task.id, {
      event: "pr.skipped",
      phase: TaskPhase.CREATE_PR,
      result: error,
    });
    return { error };
  }

  if (!repoRef) {
    const error = `Unsupported repository URL: ${project.repoUrl}`;
    await createLog(task.id, {
      event: "pr.skipped",
      phase: TaskPhase.CREATE_PR,
      result: error,
    });
    return { error };
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
  const hasCommittedDiff = gitStatus.commitsAheadOfBase > 0;
  const hasAnyDiff = hadLocalChanges || hasCommittedDiff;

  await createLog(task.id, {
    event: "git.diff_summary",
    phase: TaskPhase.CREATE_PR,
    result: JSON.stringify({
      hasUncommittedChanges: gitStatus.hasUncommittedChanges,
      branchExistsOnRemote: gitStatus.branchExistsOnRemote,
      commitsAheadOfBase: gitStatus.commitsAheadOfBase,
    }),
  });

  if (!hasAnyDiff) {
    const error = "No code changes were detected for this task; branch push and PR creation were skipped.";
    await createLog(task.id, {
      event: "git.no_changes",
      phase: TaskPhase.CREATE_PR,
      result: error,
    });
    return { error };
  }

  const needsPush = hadLocalChanges || hasCommittedDiff || !gitStatus.branchExistsOnRemote;

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

    return { error: "No existing PR found for the task branch and no push was required." };
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
    const error = "Push succeeded but no PR could be found or created.";
    await createLog(task.id, {
      event: "pr.unavailable",
      phase: TaskPhase.CREATE_PR,
      result: error,
    });
    return { error };
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

function isPullRequestRequired(): boolean {
  return process.env.FOUNDRY_REQUIRE_PULL_REQUEST?.trim().toLowerCase() !== "false";
}

function createExecutionEvidence(): ExecutionEvidence {
  return {
    editToolCalls: 0,
    writeToolCalls: 0,
    reviewCompleted: false,
  };
}

async function executeTaskWithGuards(params: {
  session: {
    sendAndWait: (options: { prompt: string }, timeoutMs?: number) => Promise<any>;
    on: (handler: (event: { type: string }) => void) => (() => void) | void;
  };
  task: Task;
  project: Project;
  prompt: string;
  evidence: ExecutionEvidence;
  workDir: string;
}): Promise<{
  parsed: OrchestratorResponse;
  resultContent: string;
  evidenceFailureReason?: string;
}> {
  let currentPrompt = params.prompt;
  let evidenceFailureReason: string | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await sendAndWaitWithSlidingTimeout(params.session, currentPrompt, params.task.id);
    const resultContent = response?.data?.content ?? "No response content";
    let parsed: OrchestratorResponse;

    try {
      parsed = parseOrchestratorResponse(resultContent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (attempt === 0) {
        evidenceFailureReason = message;
        await createLog(params.task.id, {
          event: "orchestration.invalid_response",
          phase: TaskPhase.CLASSIFY,
          result: message,
          payload: { rawContent: resultContent.slice(0, 4000) },
        });
        currentPrompt = buildInvalidResponseRetryPrompt(message);
        continue;
      }

      throw error;
    }

    if (parsed.review?.verdict) {
      params.evidence.reviewCompleted = true;
    }

    if (parsed.action === "AWAIT_PLAN_APPROVAL" && parsed.scenario !== "COMPLEX") {
      evidenceFailureReason =
        `Only COMPLEX tasks may wait for plan approval, but the agent requested approval for ${parsed.scenario}.`;
      await createLog(params.task.id, {
        event: "orchestration.invalid_approval_request",
        phase: TaskPhase.PLAN,
        result: evidenceFailureReason,
      });
      currentPrompt = buildImplementationRetryPrompt(evidenceFailureReason);
      continue;
    }

    if (parsed.action === "COMPLETE") {
      const failureReason = getImplementationEvidenceFailure({
        parsed,
        workDir: params.workDir,
        evidence: params.evidence,
      });

      if (failureReason && attempt === 0) {
        evidenceFailureReason = failureReason;
        await createLog(params.task.id, {
          event: "implementation.evidence_missing",
          phase: TaskPhase.IMPLEMENT,
          result: failureReason,
        });
        currentPrompt = buildImplementationRetryPrompt(failureReason);
        continue;
      }

      if (failureReason) {
        throw new Error(failureReason);
      }
    }

    return { parsed, resultContent, evidenceFailureReason };
  }

  throw new Error(evidenceFailureReason ?? "Task execution failed to produce valid implementation evidence.");
}

function getImplementationEvidenceFailure(params: {
  parsed: OrchestratorResponse;
  workDir: string;
  evidence: ExecutionEvidence;
}): string | null {
  const { parsed, workDir, evidence } = params;
  const gitStatus = getGitStatusSummary(workDir);
  const hasGitChanges = gitStatus.hasUncommittedChanges || gitStatus.commitsAheadOfBase > 0;
  const filesChanged = parsed.implementation?.filesChanged?.filter(Boolean) ?? [];
  const hasEditTools = evidence.editToolCalls > 0 || evidence.writeToolCalls > 0;

  if (parsed.scenario === "COMPLEX" && parsed.action === "AWAIT_PLAN_APPROVAL") {
    return null;
  }

  if (!hasGitChanges && !hasEditTools && filesChanged.length === 0) {
    return "The agent returned COMPLETE without editing files, producing a git diff, or listing changed files.";
  }

  if (!hasGitChanges && filesChanged.length > 0) {
    return "The agent claimed files were changed, but the repository has no diff.";
  }

  if (hasGitChanges && filesChanged.length === 0) {
    return "The repository has changes, but the agent did not report any changed files in its implementation summary.";
  }

  return null;
}

function buildImplementationRetryPrompt(reason: string): string {
  return `${reason}

Do not summarize or mark the task complete yet.

You must now continue execution from IMPLEMENT and perform the work in the repository.

Rules:
- MEDIUM tasks must continue automatically without human approval.
- Only COMPLEX tasks may return AWAIT_PLAN_APPROVAL.
- You may return COMPLETE only after real repository work has happened.
- Use the available tools to inspect, edit, validate, and review the code.
- Your implementation.filesChanged must list the actual changed files.
- If you truly cannot proceed safely, return FAIL with the concrete blocker.

Return only the required JSON payload.`;
}

function buildInvalidResponseRetryPrompt(reason: string): string {
  return `${reason}

Your previous response violated the orchestrator contract.

You must correct it now and continue the task.

Rules:
- Valid actions are exactly: COMPLETE, AWAIT_PLAN_APPROVAL, FAIL.
- Valid scenarios are exactly: SMALL, MEDIUM, COMPLEX.
- Valid phases are exactly: CLASSIFY, PLAN, PLAN_DRAFT, WAITING_FOR_PLAN_APPROVAL, IMPLEMENT, REVIEW, REWORK, CREATE_PR, DONE, FAILED.
- MEDIUM tasks must continue automatically without approval.
- Only COMPLEX tasks may return AWAIT_PLAN_APPROVAL.
- Do not invent intermediate action names like PLAN.
- If work is not finished, continue execution instead of summarizing.

Return only one valid JSON payload.`;
}
