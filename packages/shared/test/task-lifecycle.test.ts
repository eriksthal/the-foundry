import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import {
  V1_TASK_LIFECYCLE_STATES,
  transitionTaskLifecycle,
} from "../src/task-lifecycle.js";

test("accepts all allowed v1 lifecycle transitions", () => {
  const cases = [
    { from: "awaiting_approval", to: "approved" },
    { from: "approved", to: "in_progress" },
    { from: "in_progress", to: "done" },
    { from: "in_progress", to: "failed" },
    { from: "failed", to: "approved", manualRetry: true },
  ] as const;

  for (const lifecycleCase of cases) {
    const result = transitionTaskLifecycle(lifecycleCase);
    strictEqual(result.ok, true);
    if (result.ok) {
      strictEqual(result.to, lifecycleCase.to);
    }
  }
});

test("rejects failed -> approved when manual retry is not explicit", () => {
  const result = transitionTaskLifecycle({
    from: "failed",
    to: "approved",
  });

  strictEqual(result.ok, false);
  if (!result.ok) {
    deepStrictEqual(result.error, {
      code: "MANUAL_RETRY_REQUIRED",
      message: "manual_retry_required",
      from: "failed",
      to: "approved",
    });
  }
});

test("rejects disallowed transitions with deterministic error shape", () => {
  const result = transitionTaskLifecycle({
    from: "done",
    to: "in_progress",
  });

  strictEqual(result.ok, false);
  if (!result.ok) {
    deepStrictEqual(result.error, {
      code: "INVALID_TASK_TRANSITION",
      message: "transition_not_allowed",
      from: "done",
      to: "in_progress",
    });
  }
});

test("covers all v1 lifecycle transitions with deterministic outcomes", () => {
  const allowed = new Set([
    "awaiting_approval->approved",
    "approved->in_progress",
    "in_progress->done",
    "in_progress->failed",
  ]);

  for (const from of V1_TASK_LIFECYCLE_STATES) {
    for (const to of V1_TASK_LIFECYCLE_STATES) {
      const key = `${from}->${to}`;

      if (from === "failed" && to === "approved") {
        const blocked = transitionTaskLifecycle({ from, to });
        strictEqual(blocked.ok, false, `${key} should require manual retry`);
        if (!blocked.ok) {
          deepStrictEqual(blocked.error, {
            code: "MANUAL_RETRY_REQUIRED",
            message: "manual_retry_required",
            from,
            to,
          });
        }

        const retried = transitionTaskLifecycle({ from, to, manualRetry: true });
        strictEqual(retried.ok, true, `${key} should pass with manual retry`);
        if (retried.ok) {
          strictEqual(retried.to, to);
        }

        continue;
      }

      const result = transitionTaskLifecycle({ from, to });
      if (allowed.has(key)) {
        strictEqual(result.ok, true, `${key} should be allowed`);
        if (result.ok) {
          strictEqual(result.to, to);
        }
        continue;
      }

      strictEqual(result.ok, false, `${key} should be disallowed`);
      if (!result.ok) {
        deepStrictEqual(result.error, {
          code: "INVALID_TASK_TRANSITION",
          message: "transition_not_allowed",
          from,
          to,
        });
      }
    }
  }
});
