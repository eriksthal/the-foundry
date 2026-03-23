import { type LlmRequest, type LlmResponse, parseLlmResponse } from "@the-foundry/shared";

export type ProviderAdapter = (request: LlmRequest) => Promise<LlmResponse>;

export type ProviderRegistry = {
  codex: ProviderAdapter;
  copilot: ProviderAdapter;
};

/**
 * Dispatches a validated LLM request through the configured provider adapter.
 *
 * @throws {Error} Throws when an adapter returns data that violates the shared LLM schema.
 */
export async function callProvider(
  request: LlmRequest,
  providers: ProviderRegistry,
): Promise<LlmResponse> {
  switch (request.provider) {
    case "codex":
      return providers.codex(request);
    case "copilot":
      return providers.copilot(request);
    default:
      throw new Error(`Unsupported provider: ${String(request.provider)}`);
  }
}

export function createNotImplementedProvider(provider: "codex" | "copilot"): ProviderAdapter {
  return async function notImplemented(request: LlmRequest): Promise<LlmResponse> {
    return parseLlmResponse({
      provider,
      model: request.model,
      success: false,
      output: null,
      error: {
        code: "NOT_IMPLEMENTED",
        message: `${provider} adapter is not implemented`,
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        latencyMs: 0,
      },
    });
  };
}