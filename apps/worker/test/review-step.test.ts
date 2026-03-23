import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { reviewStep, runReviewTaskStep } from "../src/steps/review-step.js";

const baseInput = {
  provider: "copilot",
  model: "gpt-5.3-codex",
  timeoutMs: 30000,
  tokenLimits: {
    maxInputTokens: 3000,
    maxOutputTokens: 800,
  },
  changeSummary: {
    success: true,
    finishReason: "stop",
    outputPreview: "Implemented review wrapper and tests.",
  },
  ciSummary: {
    passed: true,
    failureReason: undefined,
    exitCode: 0,
    timedOut: false,
    signal: null,
    durationMs: 1200,
    logTailPreview: "lint/typecheck/test/build passed",
  },
} as const;

test("reviewStep validates request and returns shared response shape", async () => {
  const response = await reviewStep({
    provider: "copilot",
    model: "gpt-5.3-codex",
    promptPayload: {
      userInput: "Review this task",
      constraints: ["Return a concise result"],
      context: [{ key: "taskId", value: "T019" }],
    },
    timeoutMs: 30000,
    tokenLimits: {
      maxInputTokens: 3000,
      maxOutputTokens: 800,
    },
  });

  strictEqual(response.success, false);
  strictEqual(response.provider, "copilot");
  strictEqual(response.model, "gpt-5.3-codex");
});

test("runReviewTaskStep sends compact structured contract and parses deterministic decision", async () => {
  const capturedContexts: Array<Array<{ key: string; value: string }>> = [];

  const result = await runReviewTaskStep(baseInput, {
    copilotTransport: async (request) => {
      capturedContexts.push(request.promptPayload.context);
      return {
        success: true,
        text: JSON.stringify({
          passed: true,
          rationale: "Change is coherent and checks passed.",
        }),
        finishReason: "stop",
      };
    },
  });

  strictEqual(result.ok, true);
  strictEqual(result.passed, true);
  strictEqual(result.rationale, "Change is coherent and checks passed.");
  strictEqual(result.failureReason, undefined);
  strictEqual(result.artifacts.length, 1);
  strictEqual(result.artifacts[0]?.artifactKey, "review.decision");
  strictEqual(result.artifacts[0]?.data.type, "review.decision.v1");
  strictEqual(result.artifacts[0]?.data.passed, true);
  strictEqual(result.artifacts[0]?.data.rationale, "Change is coherent and checks passed.");

  strictEqual(capturedContexts.length, 1);
  deepStrictEqual(
    capturedContexts[0]?.map((entry) => entry.key),
    ["review.contract", "change.summary", "ci.summary"],
  );
  strictEqual(capturedContexts[0]?.[0]?.value, "review.input.v1");
});

test("runReviewTaskStep fails deterministically when response JSON is invalid", async () => {
  const result = await runReviewTaskStep(baseInput, {
    copilotTransport: async () => ({
      success: true,
      text: "not-json",
      finishReason: "stop",
    }),
  });

  strictEqual(result.ok, false);
  strictEqual(result.passed, false);
  strictEqual(result.rationale, "invalid_review_response:json_parse_failed");
  strictEqual(result.failureReason, "review_not_passed");
  strictEqual(result.artifacts[0]?.artifactKey, "review.decision");
  strictEqual(result.artifacts[0]?.data.passed, false);
  strictEqual(result.artifacts[0]?.data.rationale, "invalid_review_response:json_parse_failed");
});

test("runReviewTaskStep forces failed review when ci summary is failed", async () => {
  const result = await runReviewTaskStep(
    {
      ...baseInput,
      ciSummary: {
        ...baseInput.ciSummary,
        passed: false,
        failureReason: "ci_exit_1",
      },
    },
    {
      copilotTransport: async () => ({
        success: true,
        text: JSON.stringify({
          passed: true,
          rationale: "Looks good despite CI.",
        }),
        finishReason: "stop",
      }),
    },
  );

  strictEqual(result.ok, false);
  strictEqual(result.passed, false);
  strictEqual(result.rationale, "ci_failed_forces_review_fail");
  strictEqual(result.failureReason, "review_not_passed");
  strictEqual(result.artifacts[0]?.data.passed, false);
  strictEqual(result.artifacts[0]?.data.rationale, "ci_failed_forces_review_fail");
});

test("runReviewTaskStep returns deterministic adapter failure result", async () => {
  const result = await runReviewTaskStep(baseInput, {
    copilotTransport: async () => ({
      success: false,
      error: {
        code: "RATE_LIMIT",
        message: "upstream details should not leak",
      },
    }),
  });

  strictEqual(result.ok, false);
  strictEqual(result.passed, false);
  strictEqual(result.rationale, "adapter_error:RATE_LIMIT");
  strictEqual(result.failureReason, "llm_RATE_LIMIT");
  strictEqual(result.artifacts[0]?.artifactKey, "review.decision");
  strictEqual(result.artifacts[0]?.data.passed, false);
  strictEqual(result.artifacts[0]?.data.rationale, "adapter_error:RATE_LIMIT");
});
