import { strictEqual } from "node:assert";
import test from "node:test";

import { executeStep } from "../src/steps/execute-step.js";

function buildCodexRequest(overrides: Record<string, unknown> = {}) {
  return {
    provider: "codex",
    model: "gpt-5.3-codex",
    promptPayload: {
      userInput: "Summarize next action",
      constraints: ["Keep it concise"],
      context: [{ key: "taskId", value: "T014" }],
    },
    timeoutMs: 30,
    tokenLimits: {
      maxInputTokens: 4000,
      maxOutputTokens: 120,
    },
    ...overrides,
  };
}

test("codex adapter success path returns normalized success payload", async () => {
  const request = buildCodexRequest();

  const response = await executeStep(request, {
    codexTransport: async () => ({
      success: true,
      text: "Execute the migration and run checks.",
      finishReason: "stop",
      usage: {
        inputTokens: 42,
        outputTokens: 9,
      },
    }),
  });

  strictEqual(response.success, true);
  strictEqual(response.provider, "codex");
  strictEqual(response.model, "gpt-5.3-codex");
  if (response.success) {
    strictEqual(response.output.finishReason, "stop");
    strictEqual(response.usage.totalTokens, 51);
  }
});

test("codex adapter timeout path returns normalized timeout failure", async () => {
  const request = buildCodexRequest({ timeoutMs: 5 });

  const response = await executeStep(request, {
    codexTransport: async () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            success: true,
            text: "late response",
            usage: {
              inputTokens: 10,
              outputTokens: 5,
            },
          });
        }, 40);
      }),
  });

  strictEqual(response.success, false);
  if (!response.success) {
    strictEqual(response.error.code, "TIMEOUT");
  }
});

test("codex adapter enforces token guardrails per call", async () => {
  let transportCalled = false;
  const request = buildCodexRequest({
    promptPayload: {
      userInput: "This input is intentionally too long to fit the guardrail.",
      constraints: [],
      context: [],
    },
    tokenLimits: {
      maxInputTokens: 1,
      maxOutputTokens: 120,
    },
  });

  const response = await executeStep(request, {
    codexTransport: async () => {
      transportCalled = true;
      return {
        success: true,
        text: "should not run",
      };
    },
  });

  strictEqual(transportCalled, false);
  strictEqual(response.success, false);
  if (!response.success) {
    strictEqual(response.error.code, "TOKEN_LIMIT_EXCEEDED");
  }
});

test("codex adapter normalizes thrown transport errors", async () => {
  const request = buildCodexRequest();

  const response = await executeStep(request, {
    codexTransport: async () => {
      throw new Error("sensitive token sk-example should not leak");
    },
  });

  strictEqual(response.success, false);
  if (!response.success) {
    strictEqual(response.error.code, "TRANSPORT_ERROR");
    strictEqual(response.error.message, "codex transport request failed");
  }
});

test("codex adapter redacts raw provider error message text", async () => {
  const request = buildCodexRequest();

  const response = await executeStep(request, {
    codexTransport: async () => ({
      success: false,
      error: {
        code: "UPSTREAM",
        message: "api key sk-live-123 leaked",
      },
    }),
  });

  strictEqual(response.success, false);
  if (!response.success) {
    strictEqual(response.error.code, "UPSTREAM");
    strictEqual(response.error.message, "codex provider returned an error (details redacted)");
  }
});

test("codex adapter maps known provider failures to normalized safe messages", async () => {
  const request = buildCodexRequest();

  const response = await executeStep(request, {
    codexTransport: async () => ({
      success: false,
      error: {
        code: "rate-limit",
        message: "Rate limit hit for token sk-secret-456",
      },
    }),
  });

  strictEqual(response.success, false);
  if (!response.success) {
    strictEqual(response.error.code, "rate-limit");
    strictEqual(response.error.message, "codex provider rate limit exceeded");
  }
});