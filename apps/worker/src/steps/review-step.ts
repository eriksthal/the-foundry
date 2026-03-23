import {
  type LlmResponse,
  parseLlmRequest,
} from "@the-foundry/shared";

import {
  type ProviderDependencies,
  createDefaultProviderRegistry,
} from "../providers/default-provider-registry.js";
import { callProvider } from "../providers/provider-interface.js";

const SUMMARY_TEXT_LIMIT = 400;

export interface ReviewStepArtifact {
  artifactKey: string;
  data: {
    type: string;
    [key: string]: unknown;
  };
}

export interface StructuredReviewInput {
  provider: "codex" | "copilot";
  model: string;
  timeoutMs: number;
  tokenLimits: {
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  changeSummary: {
    success: boolean;
    finishReason?: string;
    outputPreview?: string;
    errorCode?: string;
  };
  ciSummary: {
    passed: boolean;
    failureReason?: string;
    exitCode: number | null;
    timedOut: boolean;
    signal: string | null;
    durationMs: number;
    logTailPreview: string;
  };
}

export interface ReviewDecision {
  passed: boolean;
  rationale: string;
}

export interface ReviewTaskStepResult {
  ok: boolean;
  passed: boolean;
  rationale: string;
  failureReason?: string;
  artifacts: ReviewStepArtifact[];
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const omission = "...<truncated>";
  return `${value.slice(0, Math.max(0, maxChars - omission.length))}${omission}`;
}

function buildCompactChangeSummary(input: StructuredReviewInput["changeSummary"]): {
  success: boolean;
  finishReason?: string;
  outputPreview?: string;
  errorCode?: string;
} {
  return {
    success: input.success,
    finishReason: input.finishReason,
    outputPreview: input.outputPreview ? truncateText(input.outputPreview, SUMMARY_TEXT_LIMIT) : undefined,
    errorCode: input.errorCode,
  };
}

function buildCompactCiSummary(input: StructuredReviewInput["ciSummary"]): {
  passed: boolean;
  failureReason?: string;
  exitCode: number | null;
  timedOut: boolean;
  signal: string | null;
  durationMs: number;
  logTailPreview: string;
} {
  return {
    passed: input.passed,
    failureReason: input.failureReason,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    signal: input.signal,
    durationMs: input.durationMs,
    logTailPreview: truncateText(input.logTailPreview, SUMMARY_TEXT_LIMIT),
  };
}

function buildStructuredReviewRequest(input: StructuredReviewInput) {
  const changeSummary = buildCompactChangeSummary(input.changeSummary);
  const ciSummary = buildCompactCiSummary(input.ciSummary);

  return parseLlmRequest({
    provider: input.provider,
    model: input.model,
    promptPayload: {
      userInput: "Review the change summary against CI summary and return a pass/fail decision.",
      instructions:
        "Return strict JSON only with keys: passed (boolean) and rationale (string).",
      constraints: [
        "Base decision only on provided structured summaries.",
        "If ciSummary.passed is false, passed must be false.",
        "Do not include markdown, code fences, or additional keys.",
      ],
      context: [
        { key: "review.contract", value: "review.input.v1" },
        { key: "change.summary", value: JSON.stringify(changeSummary) },
        { key: "ci.summary", value: JSON.stringify(ciSummary) },
      ],
    },
    timeoutMs: input.timeoutMs,
    tokenLimits: {
      maxInputTokens: input.tokenLimits.maxInputTokens,
      maxOutputTokens: input.tokenLimits.maxOutputTokens,
    },
  });
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  const withoutStart = trimmed.replace(/^```(?:json)?\s*/i, "");
  return withoutStart.replace(/\s*```$/, "").trim();
}

function parseReviewDecisionText(text: string): ReviewDecision {
  try {
    const parsed = JSON.parse(stripCodeFence(text)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        passed: false,
        rationale: "invalid_review_response:not_an_object",
      };
    }

    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.passed !== "boolean") {
      return {
        passed: false,
        rationale: "invalid_review_response:missing_boolean_passed",
      };
    }

    if (typeof candidate.rationale !== "string" || candidate.rationale.trim() === "") {
      return {
        passed: false,
        rationale: "invalid_review_response:missing_rationale",
      };
    }

    return {
      passed: candidate.passed,
      rationale: truncateText(candidate.rationale.trim(), SUMMARY_TEXT_LIMIT),
    };
  } catch {
    return {
      passed: false,
      rationale: "invalid_review_response:json_parse_failed",
    };
  }
}

function buildReviewArtifact(
  input: StructuredReviewInput,
  decision: ReviewDecision,
  response: LlmResponse | null,
): ReviewStepArtifact {
  return {
    artifactKey: "review.decision",
    data: {
      type: "review.decision.v1",
      input: {
        changeSummary: buildCompactChangeSummary(input.changeSummary),
        ciSummary: buildCompactCiSummary(input.ciSummary),
      },
      passed: decision.passed,
      rationale: decision.rationale,
      providerCall: response
        ? {
            success: response.success,
            provider: response.provider,
            model: response.model,
            usage: response.usage,
          }
        : {
            success: false,
            provider: input.provider,
            model: input.model,
          },
    },
  };
}

/**
 * Normalizes a review-step model call through the shared provider-agnostic contract.
 *
 * @throws {Error} Throws when the request or generated response violates the shared LLM schema.
 */
export async function reviewStep(
  requestInput: unknown,
  dependencies: ProviderDependencies = {},
): Promise<LlmResponse> {
  const request = parseLlmRequest(requestInput);
  const providers = createDefaultProviderRegistry(dependencies);
  return callProvider(request, providers);
}

/**
 * Runs review-step using compact structured summaries and deterministic decision parsing.
 *
 * @throws {Error} Throws when request construction fails schema validation.
 */
export async function runReviewTaskStep(
  input: StructuredReviewInput,
  dependencies: ProviderDependencies = {},
): Promise<ReviewTaskStepResult> {
  const request = buildStructuredReviewRequest(input);

  try {
    const response = await reviewStep(request, dependencies);

    if (!response.success) {
      const decision: ReviewDecision = {
        passed: false,
        rationale: `adapter_error:${response.error.code}`,
      };

      return {
        ok: false,
        passed: decision.passed,
        rationale: decision.rationale,
        failureReason: `llm_${response.error.code}`,
        artifacts: [buildReviewArtifact(input, decision, response)],
      };
    }

    const parsed = parseReviewDecisionText(response.output.text);
    const decision: ReviewDecision = input.ciSummary.passed
      ? parsed
      : {
          passed: false,
          rationale: "ci_failed_forces_review_fail",
        };

    if (decision.passed) {
      return {
        ok: true,
        passed: decision.passed,
        rationale: decision.rationale,
        artifacts: [buildReviewArtifact(input, decision, response)],
      };
    }

    return {
      ok: false,
      passed: decision.passed,
      rationale: decision.rationale,
      failureReason: "review_not_passed",
      artifacts: [buildReviewArtifact(input, decision, response)],
    };
  } catch {
    const decision: ReviewDecision = {
      passed: false,
      rationale: "adapter_error:REVIEW_STEP_ERROR",
    };

    return {
      ok: false,
      passed: decision.passed,
      rationale: decision.rationale,
      failureReason: "llm_REVIEW_STEP_ERROR",
      artifacts: [buildReviewArtifact(input, decision, null)],
    };
  }
}
