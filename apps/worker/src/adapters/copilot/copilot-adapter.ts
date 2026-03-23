import { type LlmRequest, type LlmResponse, parseLlmResponse } from "@the-foundry/shared";

import type { ProviderAdapter } from "../../providers/provider-interface.js";

type UsageLike = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

type CopilotTransportSuccess = {
  success: true;
  text: string;
  finishReason?: "stop" | "length";
  usage?: UsageLike;
};

type CopilotTransportFailure = {
  success: false;
  error?: {
    code?: string;
    message?: string;
  };
  usage?: UsageLike;
};

export type CopilotTransportResponse = CopilotTransportSuccess | CopilotTransportFailure;

export type CopilotTransportRequest = {
  model: string;
  promptPayload: LlmRequest["promptPayload"];
  tokenLimits: LlmRequest["tokenLimits"];
  signal: AbortSignal;
};

export type CopilotTransport = (
  request: CopilotTransportRequest,
) => Promise<CopilotTransportResponse>;

type CopilotAdapterDependencies = {
  transport: CopilotTransport;
  now?: () => number;
};

class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`copilot transport timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function toNonNegativeInt(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function estimateTokensFromText(value: string): number {
  const charsPerToken = 4;
  return Math.max(1, Math.ceil(value.length / charsPerToken));
}

function estimateInputTokens(request: LlmRequest): number {
  const contextTokens = request.promptPayload.context
    .map((entry) => estimateTokensFromText(entry.key) + estimateTokensFromText(entry.value))
    .reduce((sum, value) => sum + value, 0);
  const constraintTokens = request.promptPayload.constraints
    .map((constraint) => estimateTokensFromText(constraint))
    .reduce((sum, value) => sum + value, 0);
  const instructionTokens = request.promptPayload.instructions
    ? estimateTokensFromText(request.promptPayload.instructions)
    : 0;

  return (
    instructionTokens +
    estimateTokensFromText(request.promptPayload.userInput) +
    contextTokens +
    constraintTokens
  );
}

function normalizeProviderErrorMessage(code: string): string {
  const normalizedCode = code.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");

  switch (normalizedCode) {
    case "RATE_LIMIT":
    case "TOO_MANY_REQUESTS":
      return "copilot provider rate limit exceeded";
    case "AUTH":
    case "AUTHENTICATION":
    case "UNAUTHORIZED":
    case "FORBIDDEN":
      return "copilot provider authentication failed";
    case "INVALID_REQUEST":
    case "BAD_REQUEST":
      return "copilot provider rejected the request";
    case "SERVICE_UNAVAILABLE":
    case "UNAVAILABLE":
      return "copilot provider service unavailable";
    case "NOT_IMPLEMENTED":
      return "copilot provider is not configured";
    case "TIMEOUT":
      return "copilot provider request timed out";
    default:
      return "copilot provider returned an error (details redacted)";
  }
}

function normalizeFailure(
  request: LlmRequest,
  code: string,
  message: string,
  latencyMs: number,
  usage?: UsageLike,
): LlmResponse {
  const inputTokens = toNonNegativeInt(usage?.inputTokens ?? 0);
  const outputTokens = toNonNegativeInt(usage?.outputTokens ?? 0);
  const totalTokens = Math.max(toNonNegativeInt(usage?.totalTokens ?? 0), inputTokens + outputTokens);

  return parseLlmResponse({
    provider: request.provider,
    model: request.model,
    success: false,
    output: null,
    error: {
      code,
      message,
    },
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
      latencyMs,
    },
  });
}

async function withTimeout<T>(
  timeoutMs: number,
  signal: AbortController,
  operation: Promise<T>,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      signal.abort();
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Creates a Copilot adapter that normalizes transport responses to the shared LLM contract.
 *
 * @throws {Error} Throws when normalized response data violates the shared response schema.
 */
export function createCopilotAdapter(dependencies: CopilotAdapterDependencies): ProviderAdapter {
  const now = dependencies.now ?? Date.now;

  return async function callCopilot(request: LlmRequest): Promise<LlmResponse> {
    const startedAt = now();
    const estimatedInputTokens = estimateInputTokens(request);

    if (estimatedInputTokens > request.tokenLimits.maxInputTokens) {
      return normalizeFailure(
        request,
        "TOKEN_LIMIT_EXCEEDED",
        "input token estimate exceeds maxInputTokens",
        Math.max(0, now() - startedAt),
        {
          inputTokens: estimatedInputTokens,
          outputTokens: 0,
          totalTokens: estimatedInputTokens,
        },
      );
    }

    const controller = new AbortController();

    try {
      const transportResult = await withTimeout(
        request.timeoutMs,
        controller,
        dependencies.transport({
          model: request.model,
          promptPayload: request.promptPayload,
          tokenLimits: request.tokenLimits,
          signal: controller.signal,
        }),
      );

      const latencyMs = Math.max(0, now() - startedAt);

      if (!transportResult.success) {
        const providerErrorCode = transportResult.error?.code?.trim() || "PROVIDER_ERROR";

        return normalizeFailure(
          request,
          providerErrorCode,
          normalizeProviderErrorMessage(providerErrorCode),
          latencyMs,
          transportResult.usage,
        );
      }

      const outputTokens = toNonNegativeInt(
        transportResult.usage?.outputTokens ?? estimateTokensFromText(transportResult.text),
      );
      if (outputTokens > request.tokenLimits.maxOutputTokens) {
        return normalizeFailure(
          request,
          "TOKEN_LIMIT_EXCEEDED",
          "output tokens exceed maxOutputTokens",
          latencyMs,
          {
            inputTokens: transportResult.usage?.inputTokens ?? estimatedInputTokens,
            outputTokens,
            totalTokens: transportResult.usage?.totalTokens,
          },
        );
      }

      const inputTokens = toNonNegativeInt(
        transportResult.usage?.inputTokens ?? estimatedInputTokens,
      );
      const totalTokens = Math.max(
        toNonNegativeInt(transportResult.usage?.totalTokens ?? 0),
        inputTokens + outputTokens,
      );

      return parseLlmResponse({
        provider: request.provider,
        model: request.model,
        success: true,
        output: {
          text: transportResult.text,
          finishReason: transportResult.finishReason ?? "stop",
        },
        usage: {
          inputTokens,
          outputTokens,
          totalTokens,
          latencyMs,
        },
      });
    } catch (error) {
      const latencyMs = Math.max(0, now() - startedAt);

      if (error instanceof TimeoutError) {
        return normalizeFailure(
          request,
          "TIMEOUT",
          `copilot request timed out after ${error.timeoutMs}ms`,
          latencyMs,
        );
      }

      return normalizeFailure(
        request,
        "TRANSPORT_ERROR",
        "copilot transport request failed",
        latencyMs,
      );
    }
  };
}
