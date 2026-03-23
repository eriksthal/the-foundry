import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { type LlmRequest, type LlmResponse } from "@the-foundry/shared";

import { createDefaultProviderRegistry } from "../src/providers/default-provider-registry.js";
import { callProvider } from "../src/providers/provider-interface.js";

function buildRequest(provider: "codex" | "copilot"): LlmRequest {
  return {
    provider,
    model: "gpt-5.3-codex",
    promptPayload: {
      userInput: `contract test for ${provider}`,
      constraints: ["deterministic", "no-network"],
      context: [{ key: "task.id", value: "T020" }],
    },
    timeoutMs: 100,
    tokenLimits: {
      maxInputTokens: 4000,
      maxOutputTokens: 200,
    },
  };
}

test("provider interface routes to codex adapter and returns shared success contract", async () => {
  const request = buildRequest("codex");
  let codexCalls = 0;
  let copilotCalls = 0;

  const providers = createDefaultProviderRegistry({
    codexTransport: async (transportRequest) => {
      codexCalls += 1;
      strictEqual(transportRequest.model, request.model);
      strictEqual(transportRequest.promptPayload.userInput, request.promptPayload.userInput);
      return {
        success: true,
        text: "codex ok",
        finishReason: "stop",
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          totalTokens: 15,
        },
      };
    },
    copilotTransport: async () => {
      copilotCalls += 1;
      throw new Error("copilot should not be called for codex request");
    },
  });

  const response = await callProvider(request, providers);

  strictEqual(codexCalls, 1);
  strictEqual(copilotCalls, 0);
  strictEqual(response.success, true);
  strictEqual(response.provider, "codex");
  strictEqual(response.model, request.model);
  if (response.success) {
    strictEqual(response.output.text, "codex ok");
    strictEqual(response.output.finishReason, "stop");
    deepStrictEqual(response.usage, {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      latencyMs: response.usage.latencyMs,
    });
    strictEqual(Number.isInteger(response.usage.latencyMs), true);
    strictEqual(response.usage.latencyMs >= 0, true);
  }
});

test("provider interface routes to copilot adapter and returns shared success contract", async () => {
  const request = buildRequest("copilot");
  let codexCalls = 0;
  let copilotCalls = 0;

  const providers = createDefaultProviderRegistry({
    codexTransport: async () => {
      codexCalls += 1;
      throw new Error("codex should not be called for copilot request");
    },
    copilotTransport: async (transportRequest) => {
      copilotCalls += 1;
      strictEqual(transportRequest.model, request.model);
      strictEqual(transportRequest.promptPayload.userInput, request.promptPayload.userInput);
      return {
        success: true,
        text: "copilot ok",
        finishReason: "stop",
        usage: {
          inputTokens: 14,
          outputTokens: 4,
          totalTokens: 18,
        },
      };
    },
  });

  const response = await callProvider(request, providers);

  strictEqual(codexCalls, 0);
  strictEqual(copilotCalls, 1);
  strictEqual(response.success, true);
  strictEqual(response.provider, "copilot");
  strictEqual(response.model, request.model);
  if (response.success) {
    strictEqual(response.output.text, "copilot ok");
    strictEqual(response.output.finishReason, "stop");
    deepStrictEqual(response.usage, {
      inputTokens: 14,
      outputTokens: 4,
      totalTokens: 18,
      latencyMs: response.usage.latencyMs,
    });
    strictEqual(Number.isInteger(response.usage.latencyMs), true);
    strictEqual(response.usage.latencyMs >= 0, true);
  }
});

test("provider interface codex adapter normalizes provider failure messages", async () => {
  const request = buildRequest("codex");

  const providers = createDefaultProviderRegistry({
    codexTransport: async () => ({
      success: false,
      error: {
        code: "rate-limit",
        message: "raw secret sk-live-123 should be redacted",
      },
    }),
  });

  const response = await callProvider(request, providers);

  strictEqual(response.success, false);
  strictEqual(response.provider, "codex");
  if (!response.success) {
    strictEqual(response.error.code, "rate-limit");
    strictEqual(response.error.message, "codex provider rate limit exceeded");
    strictEqual(response.error.message.includes("sk-live-123"), false);
  }
});

test("provider interface copilot adapter normalizes provider failure messages", async () => {
  const request = buildRequest("copilot");

  const providers = createDefaultProviderRegistry({
    copilotTransport: async () => ({
      success: false,
      error: {
        code: "UPSTREAM",
        message: "raw token github_pat_abc should be redacted",
      },
    }),
  });

  const response = await callProvider(request, providers);

  strictEqual(response.success, false);
  strictEqual(response.provider, "copilot");
  if (!response.success) {
    strictEqual(response.error.code, "UPSTREAM");
    strictEqual(response.error.message, "copilot provider returned an error (details redacted)");
    strictEqual(response.error.message.includes("github_pat_abc"), false);
  }
});

test("provider interface handles not-implemented adapters as normalized contract failures", async () => {
  const codexResponse: LlmResponse = await callProvider(
    buildRequest("codex"),
    createDefaultProviderRegistry(),
  );
  const copilotResponse: LlmResponse = await callProvider(
    buildRequest("copilot"),
    createDefaultProviderRegistry(),
  );

  strictEqual(codexResponse.success, false);
  if (!codexResponse.success) {
    strictEqual(codexResponse.error.code, "NOT_IMPLEMENTED");
    strictEqual(codexResponse.error.message, "codex provider returned an error (details redacted)");
  }

  strictEqual(copilotResponse.success, false);
  if (!copilotResponse.success) {
    strictEqual(copilotResponse.error.code, "NOT_IMPLEMENTED");
    strictEqual(copilotResponse.error.message, "copilot provider is not configured");
  }
}
);