import { z } from "zod";

export const LLM_PROVIDERS = ["codex", "copilot"] as const;

export const llmPromptPayloadSchema = z
  .object({
    instructions: z.string().trim().min(1).max(4000).optional(),
    userInput: z.string().trim().min(1).max(12000),
    constraints: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
    context: z
      .array(
        z
          .object({
            key: z.string().trim().min(1).max(100),
            value: z.string().trim().min(1).max(2000),
          })
          .strict(),
      )
      .max(64)
      .default([]),
  })
  .strict();

export const llmTokenLimitsSchema = z
  .object({
    maxInputTokens: z.number().int().positive().max(256000),
    maxOutputTokens: z.number().int().positive().max(32000),
  })
  .strict();

export const llmRequestSchema = z
  .object({
    provider: z.enum(LLM_PROVIDERS),
    model: z.string().trim().min(1).max(120),
    promptPayload: llmPromptPayloadSchema,
    timeoutMs: z.number().int().positive().max(120000),
    tokenLimits: llmTokenLimitsSchema,
  })
  .strict();

const llmUsageMetadataSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
  })
  .strict();

const llmOutputSchema = z
  .object({
    text: z.string().max(48000),
    finishReason: z.enum(["stop", "length", "error", "timeout"]),
  })
  .strict();

const llmResponseSuccessSchema = z
  .object({
    provider: z.enum(LLM_PROVIDERS),
    model: z.string().trim().min(1).max(120),
    success: z.literal(true),
    output: llmOutputSchema,
    usage: llmUsageMetadataSchema,
  })
  .strict();

const llmResponseFailureSchema = z
  .object({
    provider: z.enum(LLM_PROVIDERS),
    model: z.string().trim().min(1).max(120),
    success: z.literal(false),
    output: z.null(),
    error: z
      .object({
        code: z.string().trim().min(1).max(100),
        message: z.string().trim().min(1).max(2000),
      })
      .strict(),
    usage: llmUsageMetadataSchema,
  })
  .strict();

export const llmResponseSchema = z.discriminatedUnion("success", [
  llmResponseSuccessSchema,
  llmResponseFailureSchema,
]);

export type LlmProvider = (typeof LLM_PROVIDERS)[number];
export type LlmPromptPayload = z.infer<typeof llmPromptPayloadSchema>;
export type LlmTokenLimits = z.infer<typeof llmTokenLimitsSchema>;
export type LlmRequest = z.infer<typeof llmRequestSchema>;
export type LlmResponse = z.infer<typeof llmResponseSchema>;

export function parseLlmRequest(input: unknown): LlmRequest {
  return llmRequestSchema.parse(input);
}

export function parseLlmResponse(input: unknown): LlmResponse {
  return llmResponseSchema.parse(input);
}
