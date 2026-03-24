import { describe, expect, it } from "vitest";
import { TaskPhase, TaskScenario } from "@the-foundry/db";
import {
  parseOrchestratorResponse,
  planApprovalStatusForScenario,
} from "./orchestration.js";

describe("parseOrchestratorResponse", () => {
  it("parses fenced JSON responses", () => {
    const result = parseOrchestratorResponse(`
\`\`\`json
{
  "version": 1,
  "scenario": "MEDIUM",
  "action": "COMPLETE",
  "phase": "DONE",
  "classification": {
    "size": "MEDIUM",
    "reason": "Touches multiple files but is straightforward.",
    "riskLevel": "medium",
    "estimatedTracks": 2,
    "needsHumanPlanApproval": false
  },
  "plan": {
    "summary": "Implement and verify the feature."
  },
  "finalSummary": "Done"
}
\`\`\`
`);

    expect(result.scenario).toBe(TaskScenario.MEDIUM);
    expect(result.phase).toBe(TaskPhase.DONE);
    expect(result.classification.estimatedTracks).toBe(2);
    expect(result.plan?.summary).toBe("Implement and verify the feature.");
  });

  it("throws on invalid payloads", () => {
    expect(() => parseOrchestratorResponse('{"scenario":"SMALL"}')).toThrow(
      "Orchestrator response missing required fields",
    );
  });
});

describe("planApprovalStatusForScenario", () => {
  it("requires approval for complex planning checkpoints", () => {
    expect(planApprovalStatusForScenario("COMPLEX", "AWAIT_PLAN_APPROVAL")).toBe(
      "PENDING",
    );
  });

  it("does not require approval for medium tasks that continue", () => {
    expect(planApprovalStatusForScenario("MEDIUM", "COMPLETE")).toBe(
      "NOT_REQUIRED",
    );
  });
});
