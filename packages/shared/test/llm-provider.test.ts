import { deepStrictEqual, strictEqual, throws } from "node:assert";
import test from "node:test";

import {
  parseLlmRequest,
  parseLlmResponse,
  type LlmRequest,
  type LlmResponse,
} from "../src/llm-provider.js";

test("accepts a bounded LLM request payload", () => {
  const request: LlmRequest = parseLlmRequest({
    provider: "copilot",
    model: "gpt-5.3-codex",
    promptPayload: {
      instructions: "Return a concise answer",
      userInput: "Summarize the task state.",
      constraints: ["Keep JSON output"],
      context: [{ key: "taskId", value: "T013" }],
    },
    timeoutMs: 30000,
    tokenLimits: {
      maxInputTokens: 8000,
      maxOutputTokens: 1200,
    },
  });

  strictEqual(request.provider, "copilot");
  strictEqual(request.tokenLimits.maxOutputTokens, 1200);
});

test("rejects non-allowlisted providers", () => {
  throws(() => {
    parseLlmRequest({
      provider: "other",
      model: "x",
      promptPayload: {
        userInput: "hello",
      },
      timeoutMs: 1000,
      tokenLimits: {
        maxInputTokens: 10,
        maxOutputTokens: 10,
      },
    });
  });
});

test("accepts success and failure response schemas", () => {
  const successResponse: LlmResponse = parseLlmResponse({
    provider: "codex",
    model: "gpt-5.3-codex",
    success: true,
    output: {
      text: "done",
      finishReason: "stop",
    },
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      latencyMs: 20,
    },
  });

  strictEqual(successResponse.success, true);

  const failureResponse: LlmResponse = parseLlmResponse({
    provider: "codex",
    model: "gpt-5.3-codex",
    success: false,
    output: null,
    error: {
      code: "NOT_IMPLEMENTED",
      message: "adapter pending",
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latencyMs: 0,
    },
  });

  strictEqual(failureResponse.success, false);
  if (!failureResponse.success) {
    deepStrictEqual(failureResponse.error.code, "NOT_IMPLEMENTED");
  }
});
