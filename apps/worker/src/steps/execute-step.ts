import {
  type LlmRequest,
  type LlmResponse,
  parseLlmRequest,
} from "@the-foundry/shared";

import {
  type ProviderDependencies,
  createDefaultProviderRegistry,
} from "../providers/default-provider-registry.js";
import { callProvider } from "../providers/provider-interface.js";

const SUMMARY_TEXT_LIMIT = 400;

export interface StepArtifact {
  artifactKey: string;
  data: {
    type: string;
    [key: string]: unknown;
  };
}

export interface ExecuteTaskStepInput {
  taskId: number;
  runId: number;
  provider: "codex" | "copilot";
  model: string;
  timeoutMs: number;
  tokenLimits: {
    maxInputTokens: number;
    maxOutputTokens: number;
  };
}

export interface ExecuteTaskStepResult {
  ok: boolean;
  failureReason?: string;
  artifacts: StepArtifact[];
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const omission = "...<truncated>";
  return `${value.slice(0, Math.max(0, maxChars - omission.length))}${omission}`;
}

function buildTaskScopedExecuteRequest(input: ExecuteTaskStepInput): LlmRequest {
  return parseLlmRequest({
    provider: input.provider,
    model: input.model,
    promptPayload: {
      userInput: `Execute task ${input.taskId} for run ${input.runId}.`,
      instructions: "Return concise implementation actions and expected checks.",
      constraints: [
        "Use only task-scoped structured context.",
        "Do not include repository-wide payloads.",
      ],
      context: [
        { key: "task.id", value: String(input.taskId) },
        { key: "run.id", value: String(input.runId) },
      ],
    },
    timeoutMs: input.timeoutMs,
    tokenLimits: {
      maxInputTokens: input.tokenLimits.maxInputTokens,
      maxOutputTokens: input.tokenLimits.maxOutputTokens,
    },
  });
}

function buildPromptSummaryArtifact(request: LlmRequest): StepArtifact {
  return {
    artifactKey: "execute.prompt.summary",
    data: {
      type: "execute.prompt.summary.v1",
      provider: request.provider,
      model: request.model,
      userInput: truncateText(request.promptPayload.userInput, SUMMARY_TEXT_LIMIT),
      instruction: truncateText(request.promptPayload.instructions ?? "", SUMMARY_TEXT_LIMIT),
      constraints: request.promptPayload.constraints,
      context: request.promptPayload.context,
    },
  };
}

function buildResponseSummaryArtifact(response: LlmResponse): StepArtifact {
  if (response.success) {
    return {
      artifactKey: "execute.response.summary",
      data: {
        type: "execute.response.summary.v1",
        success: true,
        finishReason: response.output.finishReason,
        outputPreview: truncateText(response.output.text, SUMMARY_TEXT_LIMIT),
        usage: response.usage,
      },
    };
  }

  return {
    artifactKey: "execute.response.summary",
    data: {
      type: "execute.response.summary.v1",
      success: false,
      error: {
        code: response.error.code,
        message: truncateText(response.error.message, SUMMARY_TEXT_LIMIT),
      },
      usage: response.usage,
    },
  };
}

function buildUnexpectedFailureArtifact(error: unknown): StepArtifact {
  const message = error instanceof Error ? error.message : String(error);

  return {
    artifactKey: "execute.response.summary",
    data: {
      type: "execute.response.summary.v1",
      success: false,
      error: {
        code: "EXECUTE_STEP_ERROR",
        message: truncateText(message, SUMMARY_TEXT_LIMIT),
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        latencyMs: 0,
      },
    },
  };
}

/**
 * Normalizes an execute-step model call through the shared provider-agnostic contract.
 *
 * @throws {Error} Throws when the request or generated response violates the shared LLM schema.
 */
export async function executeStep(
  requestInput: unknown,
  dependencies: ProviderDependencies = {},
): Promise<LlmResponse> {
  const request = parseLlmRequest(requestInput);
  const providers = createDefaultProviderRegistry(dependencies);
  return callProvider(request, providers);
}

/**
 * Runs execute-step using task-scoped context and returns deterministic worker-loop output.
 *
 * @throws {Error} Throws when request construction fails schema validation.
 */
export async function executeTaskStep(
  input: ExecuteTaskStepInput,
  dependencies: ProviderDependencies = {},
): Promise<ExecuteTaskStepResult> {
  const request = buildTaskScopedExecuteRequest(input);
  const promptSummaryArtifact = buildPromptSummaryArtifact(request);

  try {
    const response = await executeStep(request, dependencies);
    const responseSummaryArtifact = buildResponseSummaryArtifact(response);

    if (response.success) {
      return {
        ok: true,
        artifacts: [promptSummaryArtifact, responseSummaryArtifact],
      };
    }

    return {
      ok: false,
      failureReason: `llm_${response.error.code}`,
      artifacts: [promptSummaryArtifact, responseSummaryArtifact],
    };
  } catch (error) {
    return {
      ok: false,
      failureReason: "llm_EXECUTE_STEP_ERROR",
      artifacts: [promptSummaryArtifact, buildUnexpectedFailureArtifact(error)],
    };
  }
}
