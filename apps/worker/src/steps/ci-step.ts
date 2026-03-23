import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

import type { StepArtifact, StepResult } from "../polling-worker.js";

const DEFAULT_LOG_TAIL_MAX_CHARS = 4000;
const KILL_GRACE_PERIOD_MS = 1000;

interface LogTailState {
  value: string;
  truncated: boolean;
}

export interface CiCommandStepInput {
  command: string;
  timeoutMs: number;
  maxLogChars?: number;
  cwd?: string;
}

export interface CiCommandStepDependencies {
  spawnImpl?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  now?: () => number;
}

interface CiCommandExecutionOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  logTail: string;
  logTailTruncated: boolean;
  durationMs: number;
}

function appendToTail(state: LogTailState, value: string, maxChars: number): void {
  if (value === "") {
    return;
  }

  const next = state.value + value;
  if (next.length <= maxChars) {
    state.value = next;
    return;
  }

  state.truncated = true;
  state.value = next.slice(next.length - maxChars);
}

function buildCiArtifact(input: CiCommandStepInput, outcome: CiCommandExecutionOutcome): StepArtifact {
  return {
    artifactKey: "ci.command.log",
    data: {
      type: "ci.command.log.v1",
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      maxLogChars: input.maxLogChars ?? DEFAULT_LOG_TAIL_MAX_CHARS,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
      logTail: outcome.logTail,
      logTailTruncated: outcome.logTailTruncated,
    },
  };
}

function toFailureReason(outcome: CiCommandExecutionOutcome): string | undefined {
  if (outcome.timedOut) {
    return "ci_timeout";
  }

  if (outcome.exitCode === 0) {
    return undefined;
  }

  if (outcome.exitCode !== null) {
    return `ci_exit_${outcome.exitCode}`;
  }

  return `ci_signal_${outcome.signal ?? "unknown"}`;
}

async function runCiCommand(
  input: CiCommandStepInput,
  dependencies: CiCommandStepDependencies,
): Promise<CiCommandExecutionOutcome> {
  const spawnImpl = dependencies.spawnImpl ?? spawn;
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const maxLogChars = Math.max(1, input.maxLogChars ?? DEFAULT_LOG_TAIL_MAX_CHARS);
  const logTailState: LogTailState = {
    value: "",
    truncated: false,
  };

  return new Promise((resolve) => {
    const child = spawnImpl(input.command, [], {
      cwd: input.cwd,
      env: process.env,
      shell: true,
      stdio: "pipe",
    });

    let timedOut = false;
    let settled = false;
    let killEscalationTimer: NodeJS.Timeout | null = null;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");

      killEscalationTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, KILL_GRACE_PERIOD_MS);
    }, input.timeoutMs);

    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutTimer);
      if (killEscalationTimer) {
        clearTimeout(killEscalationTimer);
      }

      resolve({
        exitCode,
        signal,
        timedOut,
        logTail: logTailState.value,
        logTailTruncated: logTailState.truncated,
        durationMs: Math.max(0, now() - startedAt),
      });
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      appendToTail(logTailState, chunk.toString(), maxLogChars);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      appendToTail(logTailState, chunk.toString(), maxLogChars);
    });

    child.on("error", (error) => {
      appendToTail(logTailState, `\n[spawn-error] ${error.message}`, maxLogChars);
      settle(-1, null);
    });

    child.on("close", (code, signal) => {
      settle(code, signal);
    });
  });
}

export async function runCiCommandStep(
  input: CiCommandStepInput,
  dependencies: CiCommandStepDependencies = {},
): Promise<StepResult> {
  const outcome = await runCiCommand(input, dependencies);
  const artifact = buildCiArtifact(input, outcome);
  const failureReason = toFailureReason(outcome);

  if (!failureReason) {
    return {
      ok: true,
      artifacts: [artifact],
    };
  }

  return {
    ok: false,
    failureReason,
    artifacts: [artifact],
  };
}