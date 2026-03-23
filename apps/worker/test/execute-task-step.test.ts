import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { executeTaskStep } from "../src/steps/execute-step.js";

test("executeTaskStep sends only task-scoped structured context", async () => {
  const capturedRequests: Array<{
    userInput: string;
    instructions?: string;
    context: Array<{ key: string; value: string }>;
    constraints: string[];
  }> = [];

  const result = await executeTaskStep(
    {
      taskId: 17,
      runId: 1701,
      provider: "codex",
      model: "gpt-5.3-codex",
      timeoutMs: 200,
      tokenLimits: {
        maxInputTokens: 4000,
        maxOutputTokens: 1200,
      },
    },
    {
      codexTransport: async (request) => {
        capturedRequests.push({
          userInput: request.promptPayload.userInput,
          instructions: request.promptPayload.instructions,
          context: request.promptPayload.context,
          constraints: request.promptPayload.constraints,
        });
        return {
          success: true,
          text: "Apply patch and run checks.",
          finishReason: "stop",
        };
      },
    },
  );

  strictEqual(result.ok, true);
  strictEqual(capturedRequests.length, 1);
  strictEqual(capturedRequests[0]?.userInput, "Execute task 17 for run 1701.");
  strictEqual(
    capturedRequests[0]?.instructions,
    "Return concise implementation actions and expected checks.",
  );
  strictEqual(capturedRequests[0]?.userInput.includes("repository"), false);
  strictEqual(capturedRequests[0]?.instructions?.includes("repository"), false);
  deepStrictEqual(capturedRequests[0]?.context, [
    { key: "task.id", value: "17" },
    { key: "run.id", value: "1701" },
  ]);
  deepStrictEqual(capturedRequests[0]?.constraints, [
    "Use only task-scoped structured context.",
    "Do not include repository-wide payloads.",
  ]);
});

test("executeTaskStep writes bounded prompt and response summary artifacts", async () => {
  const longText = "x".repeat(2000);

  const result = await executeTaskStep(
    {
      taskId: 17,
      runId: 1702,
      provider: "copilot",
      model: "gpt-5.3-codex",
      timeoutMs: 200,
      tokenLimits: {
        maxInputTokens: 4000,
        maxOutputTokens: 1200,
      },
    },
    {
      copilotTransport: async () => ({
        success: true,
        text: longText,
        finishReason: "stop",
      }),
    },
  );

  strictEqual(result.artifacts.length, 2);
  strictEqual(result.artifacts[0]?.artifactKey, "execute.prompt.summary");
  strictEqual(result.artifacts[1]?.artifactKey, "execute.response.summary");

  const promptSummary = result.artifacts[0]?.data;
  const promptUserInput = promptSummary?.userInput;
  const promptInstruction = promptSummary?.instruction;
  strictEqual(typeof promptUserInput, "string");
  strictEqual(typeof promptInstruction, "string");
  strictEqual((promptUserInput as string).length <= 400, true);
  strictEqual((promptInstruction as string).length <= 400, true);

  const responseSummary = result.artifacts[1]?.data;
  strictEqual(responseSummary?.success, true);
  const outputPreview = responseSummary?.outputPreview;
  strictEqual(typeof outputPreview, "string");
  strictEqual((outputPreview as string).endsWith("...<truncated>"), true);
  strictEqual((outputPreview as string).length <= 400, true);
});

test("executeTaskStep returns deterministic failure object when provider fails", async () => {
  const result = await executeTaskStep(
    {
      taskId: 17,
      runId: 1703,
      provider: "codex",
      model: "gpt-5.3-codex",
      timeoutMs: 200,
      tokenLimits: {
        maxInputTokens: 4000,
        maxOutputTokens: 1200,
      },
    },
    {
      codexTransport: async () => ({
        success: false,
        error: {
          code: "RATE_LIMIT",
          message: "upstream details should stay redacted",
        },
      }),
    },
  );

  deepStrictEqual(result.ok, false);
  strictEqual(result.failureReason, "llm_RATE_LIMIT");
  strictEqual(result.artifacts.length, 2);
  strictEqual(result.artifacts[1]?.artifactKey, "execute.response.summary");
  strictEqual(result.artifacts[1]?.data.success, false);
  strictEqual(result.artifacts[1]?.data.error.code, "RATE_LIMIT");
  strictEqual(typeof result.artifacts[1]?.data.error.message, "string");
  strictEqual((result.artifacts[1]?.data.error.message as string).length <= 400, true);
});

test("executeTaskStep bounds normalized transport error summary artifact", async () => {
  const longError = "y".repeat(2000);

  const result = await executeTaskStep(
    {
      taskId: 17,
      runId: 1704,
      provider: "copilot",
      model: "gpt-5.3-codex",
      timeoutMs: 200,
      tokenLimits: {
        maxInputTokens: 4000,
        maxOutputTokens: 1200,
      },
    },
    {
      copilotTransport: async () => {
        throw new Error(longError);
      },
    },
  );

  strictEqual(result.ok, false);
  strictEqual(result.failureReason, "llm_TRANSPORT_ERROR");
  strictEqual(result.artifacts[1]?.artifactKey, "execute.response.summary");
  strictEqual(result.artifacts[1]?.data.success, false);
  strictEqual(result.artifacts[1]?.data.error.code, "TRANSPORT_ERROR");

  const message = result.artifacts[1]?.data.error.message;
  strictEqual(typeof message, "string");
  strictEqual((message as string).length <= 400, true);
  strictEqual((message as string).includes(longError.slice(0, 32)), false);
});
