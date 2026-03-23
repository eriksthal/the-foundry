import type { RunCompletionInput, WorkerApiClient } from "./api-client.js";

const MAX_ARTIFACT_LOCATION_CHARS = 2000;
const REVIEW_ARTIFACT_KEY = "review.decision";
const REVIEW_ARTIFACT_TYPE = "review.decision.v1";
const REVIEW_TEXT_PREVIEW_MAX_CHARS = 240;

export interface ClaimedTask {
  taskId: number;
  runId: number;
}

export interface StepResult {
  ok: boolean;
  failureReason?: string;
  artifacts?: StepArtifact[];
}

export interface ReviewStepResult extends StepResult {
  passed: boolean;
  rationale: string;
}

export interface StepArtifact {
  artifactKey: string;
  data: {
    type: string;
    [key: string]: unknown;
  };
}

export interface ReviewStepInput {
  changeSummary: {
    success: boolean;
    finishReason?: string;
    outputPreview?: string;
    errorCode?: string;
  };
  ciSummary: {
    passed: boolean;
    failureReason?: string;
    exitCode: number | null;
    timedOut: boolean;
    signal: string | null;
    durationMs: number;
    logTailPreview: string;
  };
}

export interface WorkerSteps {
  execute(task: ClaimedTask, context?: { signal?: AbortSignal }): Promise<StepResult>;
  ci(task: ClaimedTask, context?: { signal?: AbortSignal }): Promise<StepResult>;
  review(
    task: ClaimedTask,
    input: ReviewStepInput,
    context?: { signal?: AbortSignal },
  ): Promise<ReviewStepResult>;
}

export interface WorkerLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface PollingWorkerDependencies {
  apiClient: WorkerApiClient;
  steps: WorkerSteps;
  pollIntervalMs: number;
  runTimeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: WorkerLogger;
}

export interface PollingWorker {
  start(): void;
  stop(): Promise<void>;
  tick(): Promise<boolean>;
}

interface RunStepOutcome {
  ciPassed: boolean;
  reviewPassed: boolean;
  failureReason?: string;
  artifacts: StepArtifact[];
}

const DEFAULT_SLEEP = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const DEFAULT_LOGGER: WorkerLogger = {
  info(message, metadata) {
    console.log(message, metadata ?? {});
  },
  error(message, metadata) {
    console.error(message, metadata ?? {});
  },
};

function toFailureReason(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return `${fallback}:${error.message}`;
  }
  return fallback;
}

function normalizeFailureReason(reason: string | undefined, fallback: string): string {
  if (!reason) {
    return fallback;
  }
  const trimmed = reason.trim();
  return trimmed === "" ? fallback : trimmed;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("run_aborted");
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const omission = "...<truncated>";
  return `${value.slice(0, Math.max(0, maxChars - omission.length))}${omission}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toOptionalString(value: unknown, maxChars = REVIEW_TEXT_PREVIEW_MAX_CHARS): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  return truncateText(trimmed, maxChars);
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function toNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function toReviewStepInput(executeResult: StepResult, ciResult?: StepResult): ReviewStepInput {
  const executeSummaryData = asRecord(
    executeResult.artifacts?.find((artifact) => artifact.artifactKey === "execute.response.summary")?.data,
  );
  const executeError = asRecord(executeSummaryData?.error);

  const ciSummaryData = asRecord(
    ciResult?.artifacts?.find((artifact) => artifact.artifactKey === "ci.command.log")?.data,
  );

  const ciFailureReason = ciResult
    ? !ciResult.ok
      ? normalizeFailureReason(ciResult.failureReason, "ci_failed")
      : undefined
    : "ci_not_run";

  return {
    changeSummary: {
      success:
        typeof executeSummaryData?.success === "boolean"
          ? executeSummaryData.success
          : executeResult.ok,
      finishReason: toOptionalString(executeSummaryData?.finishReason),
      outputPreview: toOptionalString(executeSummaryData?.outputPreview),
      errorCode: toOptionalString(executeError?.code, 80),
    },
    ciSummary: {
      passed: ciResult?.ok ?? false,
      failureReason: ciFailureReason,
      exitCode: toNullableNumber(ciSummaryData?.exitCode),
      timedOut: ciSummaryData?.timedOut === true,
      signal: toNullableString(ciSummaryData?.signal),
      durationMs: toNonNegativeNumber(ciSummaryData?.durationMs),
      logTailPreview: toOptionalString(ciSummaryData?.logTail) ?? "",
    },
  };
}

function buildSystemReviewArtifact(rationale: string, input?: ReviewStepInput): StepArtifact {
  return {
    artifactKey: REVIEW_ARTIFACT_KEY,
    data: {
      type: REVIEW_ARTIFACT_TYPE,
      passed: false,
      rationale,
      source: "worker_guardrail",
      input,
    },
  };
}

function hasReviewArtifact(artifacts: StepArtifact[]): boolean {
  return artifacts.some((artifact) => artifact.artifactKey === REVIEW_ARTIFACT_KEY);
}

function toArtifactLocation(data: StepArtifact["data"]): string {
  const fallback = JSON.stringify({
    type: "artifact.serialization.error.v1",
    message: "artifact_serialization_failed",
  });

  try {
    const serialized = JSON.stringify(data);
    if (!serialized) {
      return fallback;
    }
    return truncateText(serialized, MAX_ARTIFACT_LOCATION_CHARS);
  } catch {
    return fallback;
  }
}

function toCompletionArtifacts(artifacts: StepArtifact[]): NonNullable<RunCompletionInput["artifacts"]> {
  return artifacts.map((artifact) => ({
    artifactKey: artifact.artifactKey,
    location: toArtifactLocation(artifact.data),
  }));
}

async function runWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  options: {
    onTimeout?: () => void;
  } = {},
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timeoutId = setTimeout(() => {
      settled = true;
      options.onTimeout?.();
      resolve({ timedOut: true });
    }, timeoutMs);

    void operation()
      .then((value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        resolve({ timedOut: false, value });
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

export function createPollingWorker(
  dependencies: PollingWorkerDependencies,
): PollingWorker {
  const sleep = dependencies.sleep ?? DEFAULT_SLEEP;
  const logger = dependencies.logger ?? DEFAULT_LOGGER;

  let stopped = true;
  let loopPromise: Promise<void> | null = null;
  let tickInProgress = false;

  async function runClaimedTask(task: ClaimedTask, signal: AbortSignal): Promise<RunStepOutcome> {
    throwIfAborted(signal);

    const artifacts: StepArtifact[] = [];
    const executeResult = await dependencies.steps.execute(task, { signal });
    const executeArtifacts = executeResult.artifacts ?? [];
    artifacts.push(...executeArtifacts);
    throwIfAborted(signal);

    if (!executeResult.ok) {
      const reviewInput = toReviewStepInput(executeResult);
      artifacts.push(buildSystemReviewArtifact("review_not_run_execute_failed", reviewInput));
      return {
        ciPassed: false,
        reviewPassed: false,
        failureReason: normalizeFailureReason(executeResult.failureReason, "execute_failed"),
        artifacts,
      };
    }

    const ciResult = await dependencies.steps.ci(task, { signal });
    const ciArtifacts = ciResult.artifacts ?? [];
    artifacts.push(...ciArtifacts);
    throwIfAborted(signal);

    if (!ciResult.ok) {
      const reviewInput = toReviewStepInput(executeResult, ciResult);
      artifacts.push(buildSystemReviewArtifact("review_not_run_ci_failed", reviewInput));
      return {
        ciPassed: false,
        reviewPassed: false,
        failureReason: normalizeFailureReason(ciResult.failureReason, "ci_failed"),
        artifacts,
      };
    }

    const reviewInput = toReviewStepInput(executeResult, ciResult);
    const reviewResult = await dependencies.steps.review(task, reviewInput, { signal });
    const reviewArtifacts = reviewResult.artifacts ?? [];
    artifacts.push(...reviewArtifacts);
    if (!hasReviewArtifact(reviewArtifacts)) {
      artifacts.push(
        buildSystemReviewArtifact(
          reviewResult.ok ? "review_artifact_missing_success" : "review_artifact_missing_failure",
          reviewInput,
        ),
      );
    }
    throwIfAborted(signal);

    if (!reviewResult.passed) {
      return {
        ciPassed: true,
        reviewPassed: false,
        failureReason: normalizeFailureReason(reviewResult.failureReason, "review_failed"),
        artifacts,
      };
    }

    return {
      ciPassed: true,
      reviewPassed: true,
      artifacts,
    };
  }

  async function processClaimedTask(task: ClaimedTask): Promise<void> {
    let completion: RunCompletionInput;
    const controller = new AbortController();

    try {
      const timed = await runWithTimeout(
        () => runClaimedTask(task, controller.signal),
        dependencies.runTimeoutMs,
        {
          onTimeout: () => {
            controller.abort();
          },
        },
      );
      if (timed.timedOut) {
        completion = {
          runId: task.runId,
          ciPassed: false,
          reviewPassed: false,
          failureReason: "run_timeout",
          artifacts: toCompletionArtifacts([buildSystemReviewArtifact("review_not_run_run_timeout")]),
        };
      } else {
        completion = {
          runId: task.runId,
          ciPassed: timed.value.ciPassed,
          reviewPassed: timed.value.reviewPassed,
          failureReason: timed.value.failureReason,
          artifacts: toCompletionArtifacts(timed.value.artifacts),
        };
      }
    } catch (error) {
      completion = {
        runId: task.runId,
        ciPassed: false,
        reviewPassed: false,
        failureReason: toFailureReason(error, "run_failed"),
        artifacts: toCompletionArtifacts([buildSystemReviewArtifact("review_not_run_run_failed")]),
      };
    }

    await dependencies.apiClient.completeRun(completion);
  }

  async function tick(): Promise<boolean> {
    if (tickInProgress) {
      return false;
    }

    tickInProgress = true;
    try {
      const claim = await dependencies.apiClient.claimTask();
      if (claim.taskId === null || claim.runId === null) {
        return false;
      }

      await processClaimedTask({
        taskId: claim.taskId,
        runId: claim.runId,
      });

      return true;
    } finally {
      tickInProgress = false;
    }
  }

  async function runLoop(): Promise<void> {
    while (!stopped) {
      try {
        await tick();
      } catch (error) {
        logger.error("[worker] operation=tick_failed", {
          error: toFailureReason(error, "unknown_error"),
        });
      }

      if (stopped) {
        break;
      }

      await sleep(dependencies.pollIntervalMs);
    }
  }

  return {
    start(): void {
      if (!stopped) {
        return;
      }
      stopped = false;
      loopPromise = runLoop();
      logger.info("[worker] polling_started", {
        pollIntervalMs: dependencies.pollIntervalMs,
        runTimeoutMs: dependencies.runTimeoutMs,
      });
    },
    async stop(): Promise<void> {
      stopped = true;
      if (loopPromise) {
        await loopPromise;
      }
      loopPromise = null;
      logger.info("[worker] polling_stopped");
    },
    tick,
  };
}