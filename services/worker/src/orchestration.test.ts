import { describe, expect, it } from "vitest";
import { TaskScenario } from "@the-foundry/db";
import {
  parseOrchestratorResponse,
  phaseFromAction,
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
  "classification": {
    "size": "MEDIUM",
    "reason": "Touches multiple files but is straightforward."
  },
  "plan": {
    "summary": "Implement and verify the feature."
  },
  "finalSummary": "Done"
}
\`\`\`
`);

    expect(result.scenario).toBe(TaskScenario.MEDIUM);
    expect(result.plan?.summary).toBe("Implement and verify the feature.");
  });

  it("throws on invalid payloads", () => {
    expect(() => parseOrchestratorResponse('{"scenario":"SMALL"}')).toThrow(
      "Orchestrator response missing required fields",
    );
  });

  it("throws on invalid action values", () => {
    expect(() =>
      parseOrchestratorResponse(`{
        "version": 1,
        "scenario": "MEDIUM",
        "action": "PLAN",
        "classification": {
          "size": "MEDIUM",
          "reason": "reason"
        },
        "finalSummary": "summary"
      }`),
    ).toThrow("Invalid orchestrator action: PLAN");
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

describe("phaseFromAction", () => {
  it("maps COMPLETE to DONE", () => {
    expect(phaseFromAction("COMPLETE")).toBe("DONE");
  });

  it("maps AWAIT_PLAN_APPROVAL to WAITING_FOR_PLAN_APPROVAL", () => {
    expect(phaseFromAction("AWAIT_PLAN_APPROVAL")).toBe("WAITING_FOR_PLAN_APPROVAL");
  });

  it("maps FAIL to FAILED", () => {
    expect(phaseFromAction("FAIL")).toBe("FAILED");
  });
});
