export const V1_TASK_LIFECYCLE_STATES = [
  "awaiting_approval",
  "approved",
  "in_progress",
  "done",
  "failed",
] as const;

export type TaskLifecycleState = (typeof V1_TASK_LIFECYCLE_STATES)[number];

export type TaskLifecycleTransitionErrorCode =
  | "INVALID_TASK_TRANSITION"
  | "MANUAL_RETRY_REQUIRED";

export interface TaskLifecycleTransitionError {
  code: TaskLifecycleTransitionErrorCode;
  message: string;
  from: TaskLifecycleState;
  to: TaskLifecycleState;
}

export interface TaskLifecycleTransitionSuccess {
  ok: true;
  to: TaskLifecycleState;
}

export interface TaskLifecycleTransitionFailure {
  ok: false;
  error: TaskLifecycleTransitionError;
}

export type TaskLifecycleTransitionResult =
  | TaskLifecycleTransitionSuccess
  | TaskLifecycleTransitionFailure;

export interface TaskLifecycleTransitionInput {
  from: TaskLifecycleState;
  to: TaskLifecycleState;
  manualRetry?: boolean;
}

const ALLOWED_TRANSITIONS: Readonly<Record<TaskLifecycleState, readonly TaskLifecycleState[]>> = {
  awaiting_approval: ["approved"],
  approved: ["in_progress"],
  in_progress: ["done", "failed"],
  done: [],
  failed: ["approved"],
};

const ERROR_MESSAGES: Readonly<Record<TaskLifecycleTransitionErrorCode, string>> = {
  INVALID_TASK_TRANSITION: "transition_not_allowed",
  MANUAL_RETRY_REQUIRED: "manual_retry_required",
};

/**
 * Validates and applies a v1 task lifecycle transition.
 *
 * @throws {Error} Never throws for invalid transitions; failures are returned in a deterministic error shape.
 */
export function transitionTaskLifecycle(
  input: TaskLifecycleTransitionInput,
): TaskLifecycleTransitionResult {
  const { from, to, manualRetry = false } = input;

  if (from === "failed" && to === "approved" && !manualRetry) {
    return {
      ok: false,
      error: {
        code: "MANUAL_RETRY_REQUIRED",
        message: ERROR_MESSAGES.MANUAL_RETRY_REQUIRED,
        from,
        to,
      },
    };
  }

  const nextStates = ALLOWED_TRANSITIONS[from];
  if (!nextStates.includes(to)) {
    return {
      ok: false,
      error: {
        code: "INVALID_TASK_TRANSITION",
        message: ERROR_MESSAGES.INVALID_TASK_TRANSITION,
        from,
        to,
      },
    };
  }

  return {
    ok: true,
    to,
  };
}