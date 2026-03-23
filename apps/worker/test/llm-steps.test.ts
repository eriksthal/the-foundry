import { strictEqual } from "node:assert";
import test from "node:test";

import { executeStep } from "../src/steps/execute-step.js";
import { reviewStep } from "../src/steps/review-step.js";

const request = {
  provider: "copilot",
  model: "gpt-5.3-codex",
  promptPayload: {
    userInput: "Run the next step",
    constraints: ["No side effects"],
    context: [{ key: "taskId", value: "T013" }],
  },
  timeoutMs: 30000,
  tokenLimits: {
    maxInputTokens: 4000,
    maxOutputTokens: 1000,
  },
} as const;

test("executeStep validates request and returns shared response shape", async () => {
  const response = await executeStep(request);

  strictEqual(response.success, false);
  strictEqual(response.provider, request.provider);
  strictEqual(response.model, request.model);
});

test("executeStep dispatches only the selected provider through adapter wiring", async () => {
  let codexCalls = 0;
  let copilotCalls = 0;

  const response = await executeStep(request, {
    codexTransport: async () => {
      codexCalls += 1;
      return {
        success: true,
        text: "codex should not be invoked",
      };
    },
    copilotTransport: async () => {
      copilotCalls += 1;
      return {
        success: true,
        text: "run execute step",
        finishReason: "stop",
      };
    },
  });

  strictEqual(codexCalls, 0);
  strictEqual(copilotCalls, 1);
  strictEqual(response.success, true);
  strictEqual(response.provider, request.provider);
  strictEqual(response.model, request.model);
});

test("reviewStep validates request and returns shared response shape", async () => {
  const response = await reviewStep(request);

  strictEqual(response.success, false);
  strictEqual(response.provider, request.provider);
  strictEqual(response.model, request.model);
});
