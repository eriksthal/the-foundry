import { PlanApprovalStatus, TaskPhase, TaskScenario, type Task } from "@the-foundry/db";

export type OrchestrationAction = "COMPLETE" | "AWAIT_PLAN_APPROVAL" | "FAIL";
export type ReviewVerdict = "APPROVED" | "CHANGES_REQUESTED";

export type PlanStep = {
  id: string;
  title: string;
  files?: string[];
};

export type OrchestratorResponse = {
  version: 1;
  scenario: keyof typeof TaskScenario;
  action: OrchestrationAction;
  classification: {
    size: keyof typeof TaskScenario;
    reason: string;
  };
  plan?: {
    summary: string;
    steps?: PlanStep[];
  };
  implementation?: {
    summary: string;
    filesChanged?: string[];
  };
  review?: {
    verdict: ReviewVerdict;
    summary: string;
  };
  finalSummary: string;
};

const VALID_SCENARIOS = new Set<keyof typeof TaskScenario>(["SMALL", "MEDIUM", "COMPLEX"]);
const VALID_ACTIONS = new Set<OrchestrationAction>(["COMPLETE", "AWAIT_PLAN_APPROVAL", "FAIL"]);

export function buildInitialTaskPrompt(task: Task, branchName: string): string {
  return `## Task
Title: ${task.title}

Description:
${task.description}

## Context
- Branch: ${branchName}
- Task ID: ${task.id}
- Plan approval status: ${task.planApprovalStatus}

## Workflow
1. Read enough of the repository to classify the task as SMALL, MEDIUM, or COMPLEX.
2. If COMPLEX: delegate to planner for a full plan, then STOP with action AWAIT_PLAN_APPROVAL.
3. If MEDIUM: delegate to planner for a brief plan, then continue to implementation.
4. If SMALL: proceed directly to implementation.
5. Delegate implementation to the implementer subagent with clear scope and acceptance criteria. The implementer must run format, lint, typecheck, and tests before returning.
6. Delegate review to the reviewer subagent. The reviewer must verify that format, lint, typecheck, and tests all pass — any CI failure is a BLOCKER.
7. If the reviewer requests changes, delegate fixes to the implementer and review again.
8. When review passes with APPROVED verdict, return your response.

${baseInstructions()}`;
}

export function buildResumePrompt(task: Task): string {
  const planJson = task.planContent ? JSON.stringify(task.planContent, null, 2) : "{}";

  return `## Resume Context
- Task ID: ${task.id}
- Branch: ${task.branch ?? "unknown"}
- Scenario: ${task.scenario ?? "unknown"}

The plan has been approved. Resume from implementation.

## Approved Plan
\`\`\`json
${planJson}
\`\`\`

## Instructions
1. Implement the approved plan using implementer subagents.
2. Review with the reviewer subagent.
3. If the reviewer requests changes, delegate fixes to the implementer and review again.
4. Return your response.

${baseInstructions()}`;
}

export function parseOrchestratorResponse(content: string): OrchestratorResponse {
  const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)```/i);
  const raw = jsonBlockMatch?.[1] ?? content;
  const parsed = JSON.parse(raw.trim()) as Partial<OrchestratorResponse>;

  if (!parsed.scenario || !parsed.action || !parsed.classification || !parsed.finalSummary) {
    throw new Error("Orchestrator response missing required fields");
  }

  if (!VALID_SCENARIOS.has(parsed.scenario)) {
    throw new Error(`Invalid orchestrator scenario: ${String(parsed.scenario)}`);
  }

  if (!VALID_ACTIONS.has(parsed.action as OrchestrationAction)) {
    throw new Error(`Invalid orchestrator action: ${String(parsed.action)}`);
  }

  if (parsed.review?.verdict && !["APPROVED", "CHANGES_REQUESTED"].includes(parsed.review.verdict as string)) {
    throw new Error(`Invalid review verdict: ${String(parsed.review.verdict)}`);
  }

  return {
    version: 1,
    scenario: parsed.scenario,
    action: parsed.action,
    classification: {
      size: parsed.classification.size ?? parsed.scenario,
      reason: parsed.classification.reason ?? "No classification reason provided",
    },
    plan: parsed.plan,
    implementation: parsed.implementation,
    review: parsed.review,
    finalSummary: parsed.finalSummary,
  };
}

export function planApprovalStatusForScenario(
  scenario: keyof typeof TaskScenario,
  action: OrchestrationAction,
): keyof typeof PlanApprovalStatus {
  if (scenario === "COMPLEX" && action === "AWAIT_PLAN_APPROVAL") return "PENDING";
  return "NOT_REQUIRED";
}

export function phaseFromAction(action: OrchestrationAction): keyof typeof TaskPhase {
  switch (action) {
    case "COMPLETE": return "DONE";
    case "AWAIT_PLAN_APPROVAL": return "WAITING_FOR_PLAN_APPROVAL";
    case "FAIL": return "FAILED";
  }
}

function baseInstructions(): string {
  return `## MANDATORY: Work before responding
You MUST delegate to at least one subagent (implementer) AND have the reviewer approve
BEFORE returning your JSON response. A response without prior tool usage and subagent
delegation will be automatically rejected and the task will fail.

## Rules
- COMPLETE requires actual file changes in the repository (verified by git diff).
- FAIL requires tool-verified evidence of a concrete blocker.
- Only COMPLEX tasks may use AWAIT_PLAN_APPROVAL.
- SMALL and MEDIUM tasks must reach completion in this session. Do not stop after investigation or planning.
- Never ask for clarification. Make safe assumptions and proceed.
- Return exactly one JSON object in a \`\`\`json fenced block. No other text.
- Never fabricate repository, branch, commit, or pull request URLs.

## Response format
\`\`\`json
{
  "version": 1,
  "scenario": "SMALL | MEDIUM | COMPLEX",
  "action": "COMPLETE | AWAIT_PLAN_APPROVAL | FAIL",
  "classification": {
    "size": "SMALL | MEDIUM | COMPLEX",
    "reason": "one sentence"
  },
  "plan": {
    "summary": "what will be / was done",
    "steps": [{ "id": "1", "title": "step title", "files": ["path/to/file.ts"] }]
  },
  "implementation": {
    "summary": "what was implemented",
    "filesChanged": ["path/to/file.ts"]
  },
  "review": {
    "verdict": "APPROVED | CHANGES_REQUESTED",
    "summary": "review outcome"
  },
  "finalSummary": "human-readable outcome"
}
\`\`\``;
}
