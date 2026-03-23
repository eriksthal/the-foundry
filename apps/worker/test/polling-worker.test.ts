import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { createPollingWorker } from "../src/polling-worker.js";

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function waitFor(
  predicate: () => boolean,
  maxIterations = 50,
): Promise<void> {
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (predicate()) {
      return;
    }
    await flushMicrotasks();
  }

  throw new Error("wait_for_condition_failed");
}

test("tick handles empty queue without crashing", async () => {
  let executeCalls = 0;
  let completeCalls = 0;

  const worker = createPollingWorker({
    apiClient: {
      async claimTask() {
        return { taskId: null, runId: null };
      },
      async completeRun() {
        completeCalls += 1;
      },
    },
    steps: {
      async execute() {
        executeCalls += 1;
        return { ok: true };
      },
      async ci() {
        return { ok: true };
      },
      async review() {
        return { ok: true, passed: true, rationale: "review_passed" };
      },
    },
    pollIntervalMs: 100,
    runTimeoutMs: 200,
    sleep: async () => undefined,
  });

  const processed = await worker.tick();

  strictEqual(processed, false);
  strictEqual(executeCalls, 0);
  strictEqual(completeCalls, 0);
});

test("tick enforces at most one claimed task concurrently", async () => {
  let claimCalls = 0;
  let completeCalls = 0;
  let releaseClaim: (() => void) | undefined;
  const claimBarrier = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });

  const worker = createPollingWorker({
    apiClient: {
      async claimTask() {
        claimCalls += 1;
        if (claimCalls === 1) {
          await claimBarrier;
          return { taskId: 10, runId: 1001 };
        }
        return { taskId: 11, runId: 1002 };
      },
      async completeRun() {
        completeCalls += 1;
      },
    },
    steps: {
      async execute() {
        return { ok: true };
      },
      async ci() {
        return { ok: true };
      },
      async review() {
        return { ok: true, passed: true, rationale: "review_passed" };
      },
    },
    pollIntervalMs: 100,
    runTimeoutMs: 200,
    sleep: async () => undefined,
  });

  const firstTick = worker.tick();
  const secondTick = worker.tick();

  releaseClaim?.();

  const [firstProcessed, secondProcessed] = await Promise.all([firstTick, secondTick]);

  strictEqual(firstProcessed, true);
  strictEqual(secondProcessed, false);
  strictEqual(claimCalls, 1);
  strictEqual(completeCalls, 1);
});

test("polling loop uses fixed interval cadence between ticks", async () => {
  const sleepCalls: number[] = [];
  const sleepResolvers: Array<() => void> = [];

  const worker = createPollingWorker({
    apiClient: {
      async claimTask() {
        return { taskId: null, runId: null };
      },
      async completeRun() {
        throw new Error("completeRun should not be called for empty queue");
      },
    },
    steps: {
      async execute() {
        return { ok: true };
      },
      async ci() {
        return { ok: true };
      },
      async review() {
        return { ok: true, passed: true, rationale: "review_passed" };
      },
    },
    pollIntervalMs: 25,
    runTimeoutMs: 200,
    sleep: async (ms) =>
      new Promise<void>((resolve) => {
        sleepCalls.push(ms);
        sleepResolvers.push(resolve);
      }),
  });

  worker.start();

  await waitFor(() => sleepResolvers.length === 1);
  strictEqual(sleepCalls[0], 25);
  sleepResolvers.shift()?.();

  await waitFor(() => sleepResolvers.length === 1);
  strictEqual(sleepCalls[1], 25);

  const stopPromise = worker.stop();
  sleepResolvers.shift()?.();
  await stopPromise;

  deepStrictEqual(sleepCalls, [25, 25]);
});

test("runs execute then ci then review in order for a successful claim", async () => {
  const observedOrder: string[] = [];

  const worker = createPollingWorker({
    apiClient: {
      async claimTask() {
        return { taskId: 15, runId: 1501 };
      },
      async completeRun() {
        observedOrder.push("completeRun");
      },
    },
    steps: {
      async execute() {
        observedOrder.push("execute");
        return { ok: true };
      },
      async ci() {
        observedOrder.push("ci");
        return { ok: true };
      },
      async review() {
        observedOrder.push("review");
        return { ok: true, passed: true, rationale: "review_passed" };
      },
    },
    pollIntervalMs: 100,
    runTimeoutMs: 200,
    sleep: async () => undefined,
  });

  const processed = await worker.tick();

  strictEqual(processed, true);
  deepStrictEqual(observedOrder, ["execute", "ci", "review", "completeRun"]);
});

test("passes structured change and ci summaries into review step", async () => {
  let capturedReviewInput:
    | {
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
    | undefined;

  const worker = createPollingWorker({
    apiClient: {
      async claimTask() {
        return { taskId: 18, runId: 1801 };
      },
      async completeRun() {
        return;
      },
    },
    steps: {
      async execute() {
        return {
          ok: true,
          artifacts: [
            {
              artifactKey: "execute.response.summary",
              data: {
                type: "execute.response.summary.v1",
                success: true,
                finishReason: "stop",
                outputPreview: "implemented patch",
              },
            },
          ],
        };
      },
      async ci() {
        return {
          ok: true,
          artifacts: [
            {
              artifactKey: "ci.command.log",
              data: {
                type: "ci.command.log.v1",
                exitCode: 0,
                timedOut: false,
                signal: null,
                durationMs: 42,
                logTail: "all checks passed",
              },
            },
          ],
        };
      },
      async review(_task, input) {
        capturedReviewInput = input;
        return {
          ok: true,
          passed: true,
          rationale: "looks good",
          artifacts: [
            {
              artifactKey: "review.decision",
              data: {
                type: "review.decision.v1",
                passed: true,
                rationale: "looks good",
              },
            },
          ],
        };
      },
    },
    pollIntervalMs: 100,
    runTimeoutMs: 200,
    sleep: async () => undefined,
  });

  const processed = await worker.tick();

  strictEqual(processed, true);
  deepStrictEqual(capturedReviewInput, {
    changeSummary: {
      success: true,
      finishReason: "stop",
      outputPreview: "implemented patch",
      errorCode: undefined,
    },
    ciSummary: {
      passed: true,
      failureReason: undefined,
      exitCode: 0,
      timedOut: false,
      signal: null,
      durationMs: 42,
      logTailPreview: "all checks passed",
    },
  });
});

test("skips downstream steps when execute fails", async () => {
  let executeCalls = 0;
  let ciCalls = 0;
  let reviewCalls = 0;

  const worker = createPollingWorker({
    apiClient: {
      async claimTask() {
        return { taskId: 16, runId: 1601 };
      },
      async completeRun() {
        return;
      },
    },
    steps: {
      async execute() {
        executeCalls += 1;
        return { ok: false, failureReason: "execute_failed_explicit" };
      },
      async ci() {
        ciCalls += 1;
        return { ok: true };
      },
      async review() {
        reviewCalls += 1;
        return { ok: true, passed: true, rationale: "review_passed" };
      },
    },
    pollIntervalMs: 100,
    runTimeoutMs: 200,
    sleep: async () => undefined,
  });

  const processed = await worker.tick();

  strictEqual(processed, true);
  strictEqual(executeCalls, 1);
  strictEqual(ciCalls, 0);
  strictEqual(reviewCalls, 0);
});

test("submits completion with failure details when a step fails", async () => {
  const completionInputs: Array<{
    runId: number;
    ciPassed: boolean;
    reviewPassed: boolean;
    failureReason?: string;
  }> = [];

  const worker = createPollingWorker({
    apiClient: {
      async claimTask() {
        return { taskId: 21, runId: 2101 };
      },
      async completeRun(input) {
        completionInputs.push({
          runId: input.runId,
          ciPassed: input.ciPassed,
          reviewPassed: input.reviewPassed,
          failureReason: input.failureReason,
        });
      },
    },
    steps: {
      async execute() {
        throw new Error("execute exploded");
      },
      async ci() {
        return { ok: true };
      },
      async review() {
        return { ok: true, passed: true, rationale: "review_passed" };
      },
    },
    pollIntervalMs: 100,
    runTimeoutMs: 200,
    sleep: async () => undefined,
  });

  const processed = await worker.tick();

  strictEqual(processed, true);
  strictEqual(completionInputs.length, 1);
  deepStrictEqual(completionInputs[0], {
    runId: 2101,
    ciPassed: false,
    reviewPassed: false,
    failureReason: "run_failed:execute exploded",
  });
});

test("marks run as failed when hard runtime timeout is reached", async () => {
  const completionInputs: Array<{
    runId: number;
    ciPassed: boolean;
    reviewPassed: boolean;
    failureReason?: string;
  }> = [];

  const worker = createPollingWorker({
    apiClient: {
      async claimTask() {
        return { taskId: 31, runId: 3101 };
      },
      async completeRun(input) {
        completionInputs.push({
          runId: input.runId,
          ciPassed: input.ciPassed,
          reviewPassed: input.reviewPassed,
          failureReason: input.failureReason,
        });
      },
    },
    steps: {
      async execute() {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({ ok: true });
          }, 40);
        });
      },
      async ci() {
        return { ok: true };
      },
      async review() {
        return { ok: true, passed: true, rationale: "review_passed" };
      },
    },
    pollIntervalMs: 100,
    runTimeoutMs: 5,
    sleep: async () => undefined,
  });

  await worker.tick();

  strictEqual(completionInputs.length, 1);
  deepStrictEqual(completionInputs[0], {
    runId: 3101,
    ciPassed: false,
    reviewPassed: false,
    failureReason: "run_timeout",
  });
});

test("completes successful run with explicit success payload", async () => {
  const completionInputs: Array<{
    runId: number;
    ciPassed: boolean;
    reviewPassed: boolean;
    failureReason?: string;
    artifacts?: Array<{ artifactKey: string; location: string }>;
  }> = [];

  const worker = createPollingWorker({
    apiClient: {
      async claimTask() {
        return { taskId: 32, runId: 3201 };
      },
      async completeRun(input) {
        completionInputs.push({
          runId: input.runId,
          ciPassed: input.ciPassed,
          reviewPassed: input.reviewPassed,
          failureReason: input.failureReason,
          artifacts: input.artifacts,
        });
      },
    },
    steps: {
      async execute() {
        return { ok: true };
      },
      async ci() {
        return { ok: true };
      },
      async review() {
        return { ok: true, passed: true, rationale: "review_passed" };
      },
    },
    pollIntervalMs: 100,
    runTimeoutMs: 200,
    sleep: async () => undefined,
  });

  const processed = await worker.tick();

  strictEqual(processed, true);
  strictEqual(completionInputs.length, 1);
  strictEqual(completionInputs[0]?.runId, 3201);
  strictEqual(completionInputs[0]?.ciPassed, true);
  strictEqual(completionInputs[0]?.reviewPassed, true);
  strictEqual(completionInputs[0]?.failureReason, undefined);
  strictEqual(completionInputs[0]?.artifacts?.length, 1);
  strictEqual(completionInputs[0]?.artifacts?.[0]?.artifactKey, "review.decision");
});

test("serializes and truncates execute artifacts before completion persistence", async () => {
  const completionInputs: Array<{
    runId: number;
    artifacts?: Array<{ artifactKey: string; location: string }>;
  }> = [];

  const worker = createPollingWorker({
    apiClient: {
      async claimTask() {
        return { taskId: 33, runId: 3301 };
      },
      async completeRun(input) {
        completionInputs.push({
          runId: input.runId,
          artifacts: input.artifacts,
        });
      },
    },
    steps: {
      async execute() {
        return {
          ok: true,
          artifacts: [
            {
              artifactKey: "execute.response.summary",
              data: {
                type: "execute.response.summary.v1",
                success: true,
                outputPreview: "x".repeat(8000),
              },
            },
          ],
        };
      },
      async ci() {
        return { ok: true };
      },
      async review() {
        return { ok: true };
      },
    },
    pollIntervalMs: 100,
    runTimeoutMs: 200,
    sleep: async () => undefined,
  });

  const processed = await worker.tick();

  strictEqual(processed, true);
  strictEqual(completionInputs.length, 1);
  strictEqual(completionInputs[0]?.runId, 3301);
  strictEqual(completionInputs[0]?.artifacts?.length, 2);
  strictEqual(completionInputs[0]?.artifacts?.[0]?.artifactKey, "execute.response.summary");
  strictEqual(completionInputs[0]?.artifacts?.[0]?.location.length <= 2000, true);
  strictEqual(
    completionInputs[0]?.artifacts?.[0]?.location.endsWith("...<truncated>"),
    true,
  );
  strictEqual(completionInputs[0]?.artifacts?.[1]?.artifactKey, "review.decision");
});

test("includes ci artifacts in completion payload for debugging", async () => {
  const completionInputs: Array<{
    runId: number;
    artifacts?: Array<{ artifactKey: string; location: string }>;
  }> = [];
  let reviewCalls = 0;

  const worker = createPollingWorker({
    apiClient: {
      async claimTask() {
        return { taskId: 34, runId: 3401 };
      },
      async completeRun(input) {
        completionInputs.push({
          runId: input.runId,
          artifacts: input.artifacts,
        });
      },
    },
    steps: {
      async execute() {
        return { ok: true };
      },
      async ci() {
        return {
          ok: false,
          failureReason: "ci_exit_1",
          artifacts: [
            {
              artifactKey: "ci.command.log",
              data: {
                type: "ci.command.log.v1",
                logTail: "failing-ci-log",
              },
            },
          ],
        };
      },
      async review() {
        reviewCalls += 1;
        return { ok: true, passed: true, rationale: "review_passed" };
      },
    },
    pollIntervalMs: 100,
    runTimeoutMs: 200,
    sleep: async () => undefined,
  });

  const processed = await worker.tick();

  strictEqual(processed, true);
  strictEqual(completionInputs.length, 1);
  strictEqual(completionInputs[0]?.runId, 3401);
  strictEqual(reviewCalls, 0);
  strictEqual(completionInputs[0]?.artifacts?.length, 2);
  strictEqual(completionInputs[0]?.artifacts?.[0]?.artifactKey, "ci.command.log");
  strictEqual(completionInputs[0]?.artifacts?.[0]?.location.includes("failing-ci-log"), true);
  strictEqual(completionInputs[0]?.artifacts?.[1]?.artifactKey, "review.decision");
  strictEqual(
    completionInputs[0]?.artifacts?.[1]?.location.includes("review_not_run_ci_failed"),
    true,
  );
});

test("hard timeout prevents timed-out task from running downstream steps after next claim", async () => {
  const ciTaskIds: number[] = [];
  const reviewTaskIds: number[] = [];
  const completionInputs: Array<{
    runId: number;
    ciPassed: boolean;
    reviewPassed: boolean;
    failureReason?: string;
  }> = [];

  let claimCount = 0;
  let releaseFirstExecute: (() => void) | undefined;
  const firstExecuteBarrier = new Promise<void>((resolve) => {
    releaseFirstExecute = resolve;
  });

  const worker = createPollingWorker({
    apiClient: {
      async claimTask() {
        claimCount += 1;
        if (claimCount === 1) {
          return { taskId: 41, runId: 4101 };
        }
        if (claimCount === 2) {
          return { taskId: 42, runId: 4201 };
        }
        return { taskId: null, runId: null };
      },
      async completeRun(input) {
        completionInputs.push({
          runId: input.runId,
          ciPassed: input.ciPassed,
          reviewPassed: input.reviewPassed,
          failureReason: input.failureReason,
        });
      },
    },
    steps: {
      async execute(task) {
        if (task.taskId === 41) {
          await firstExecuteBarrier;
        }
        return { ok: true };
      },
      async ci(task) {
        ciTaskIds.push(task.taskId);
        return { ok: true };
      },
      async review(task) {
        reviewTaskIds.push(task.taskId);
        return { ok: true, passed: true, rationale: "review_passed" };
      },
    },
    pollIntervalMs: 100,
    runTimeoutMs: 5,
    sleep: async () => undefined,
  });

  const firstProcessed = await worker.tick();
  const secondProcessed = await worker.tick();

  strictEqual(firstProcessed, true);
  strictEqual(secondProcessed, true);

  releaseFirstExecute?.();
  await flushMicrotasks();
  await flushMicrotasks();

  deepStrictEqual(ciTaskIds, [42]);
  deepStrictEqual(reviewTaskIds, [42]);
  deepStrictEqual(completionInputs, [
    {
      runId: 4101,
      ciPassed: false,
      reviewPassed: false,
      failureReason: "run_timeout",
    },
    {
      runId: 4201,
      ciPassed: true,
      reviewPassed: true,
      failureReason: undefined,
    },
  ]);
});