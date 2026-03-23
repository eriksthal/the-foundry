import { strictEqual } from "node:assert";
import test from "node:test";

import { executeStep } from "../src/steps/execute-step.js";

function buildCopilotRequest(overrides: Record<string, unknown> = {}) {
  return {
    provider: "copilot",
    model: "gpt-5.3-codex",
    promptPayload: {
      userInput: "Summarize next action",
      constraints: ["Keep it concise"],
      context: [{ key: "taskId", value: "T015" }],
    },
    timeoutMs: 30,
    tokenLimits: {
      maxInputTokens: 4000,
      maxOutputTokens: 120,
    },
    ...overrides,
  };
}

test("copilot adapter success path returns normalized success payload", async () => {
  const request = buildCopilotRequest();

  const response = await executeStep(request, {
    copilotTransport: async () => ({
      success: true,
      text: "Execute implementation and run checks.",
      finishReason: "stop",
      usage: {
        inputTokens: 45,
        outputTokens: 8,
      },
    }),
  });

  strictEqual(response.success, true);
  strictEqual(response.provider, "copilot");
  strictEqual(response.model, "gpt-5.3-codex");
  if (response.success) {
    strictEqual(response.output.finishReason, "stop");
    strictEqual(response.usage.totalTokens, 53);
  }
});

test("copilot adapter timeout path returns normalized timeout failure", async () => {
  const request = buildCopilotRequest({ timeoutMs: 5 });

  const response = await executeStep(request, {
    copilotTransport: async () =>
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

test("copilot adapter enforces token guardrails per call", async () => {
  let transportCalled = false;
  const request = buildCopilotRequest({
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
    copilotTransport: async () => {
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

test("copilot adapter normalizes thrown transport errors", async () => {
  const request = buildCopilotRequest();

  const response = await executeStep(request, {
    copilotTransport: async () => {
      throw new Error("sensitive token github_pat_abc should not leak");
    },
  });

  strictEqual(response.success, false);
  if (!response.success) {
    strictEqual(response.error.code, "TRANSPORT_ERROR");
    strictEqual(response.error.message, "copilot transport request failed");
  }
});

test("copilot adapter redacts raw provider error message text", async () => {
  const request = buildCopilotRequest();

  const response = await executeStep(request, {
    copilotTransport: async () => ({
      success: false,
      error: {
        code: "UPSTREAM",
        message: "api key ghu_123 leaked",
      },
    }),
  });

  strictEqual(response.success, false);
  if (!response.success) {
    strictEqual(response.error.code, "UPSTREAM");
    strictEqual(response.error.message, "copilot provider returned an error (details redacted)");
  }
});

test("copilot adapter maps known provider failures to normalized safe messages", async () => {
  const request = buildCopilotRequest();

  const response = await executeStep(request, {
    copilotTransport: async () => ({
      success: false,
      error: {
        code: "rate-limit",
        message: "Rate limit hit for token github_pat_xyz",
      },
    }),
  });

  strictEqual(response.success, false);
  if (!response.success) {
    strictEqual(response.error.code, "rate-limit");
    strictEqual(response.error.message, "copilot provider rate limit exceeded");
  }
});
