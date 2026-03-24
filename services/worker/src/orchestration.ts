import { PlanApprovalStatus, TaskPhase, TaskScenario, type Task } from "@the-foundry/db";

export type OrchestrationAction = "COMPLETE" | "AWAIT_PLAN_APPROVAL" | "FAIL";
export type ReviewVerdict = "APPROVED" | "CHANGES_REQUESTED" | "NOT_RUN";

export type PlanStep = {
  id: string;
  title: string;
  files?: string[];
  acceptanceCriteria?: string;
  track?: string;
  status?: "PENDING" | "IN_PROGRESS" | "DONE" | "BLOCKED";
};

export type OrchestratorResponse = {
  version: 1;
  scenario: keyof typeof TaskScenario;
  action: OrchestrationAction;
  phase: keyof typeof TaskPhase;
  classification: {
    size: keyof typeof TaskScenario;
    reason: string;
    riskLevel: string;
    estimatedTracks: number;
    needsHumanPlanApproval: boolean;
  };
  plan?: {
    summary: string;
    risks?: string[];
    assumptions?: string[];
    rollback?: string[];
    steps?: PlanStep[];
  };
  implementation?: {
    summary: string;
    filesChanged?: string[];
    validations?: string[];
    blockers?: string[];
  };
  review?: {
    verdict: ReviewVerdict;
    summary: string;
    findings?: Array<{
      severity: "BLOCKER" | "WARNING" | "SUGGESTION";
      file?: string;
      detail: string;
    }>;
  };
  finalSummary: string;
  prUrl?: string;
};

export function buildInitialTaskPrompt(task: Task, branchName: string): string {
  return `${baseInstructions()}

## Execution Context
- Task ID: ${task.id}
- Branch to use: ${branchName}
- Current scenario: unknown
- Current phase: CLASSIFY
- Plan approval status: ${task.planApprovalStatus}

## Task
Title: ${task.title}

Description:
${task.description}

## What to do
1. Classify the task as SMALL, MEDIUM, or COMPLEX using the repository context.
2. Follow the scenario workflow deterministically:
   - SMALL: skip planner unless hidden risk is discovered, then implement, review, rework if needed, create PR, finish.
   - MEDIUM: produce an executable plan, then implement, review, rework if needed, create PR, finish.
   - COMPLEX: produce a full plan package and STOP after planning with action AWAIT_PLAN_APPROVAL.
3. Never ask follow-up questions. Pick the safest reasonable assumption, record it, and continue.
4. Use subagents intentionally. The planner returns plans, implementers write code, reviewers gate quality.
5. Return only the required JSON payload.`;
}

export function buildResumePrompt(task: Task): string {
  const planJson = task.planContent ? JSON.stringify(task.planContent, null, 2) : "{}";

  return `${baseInstructions()}

## Resume Context
- Task ID: ${task.id}
- Branch: ${task.branch ?? "unknown"}
- Current scenario: ${task.scenario ?? "unknown"}
- Current phase: ${task.phase ?? "unknown"}
- Plan approval status: ${task.planApprovalStatus}

The plan has now been approved. Resume execution from implementation using the approved plan below. Do not re-classify unless the plan is clearly inconsistent with the repository.

## Approved Plan
\`\`\`json
${planJson}
\`\`\`

## Resume instructions
1. Continue from IMPLEMENT.
2. Preserve continuity with the previously approved plan.
3. Run reviewer gating before finalizing.
4. Return only the required JSON payload.`;
}

export function parseOrchestratorResponse(content: string): OrchestratorResponse {
  const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)```/i);
  const raw = jsonBlockMatch?.[1] ?? content;
  const parsed = JSON.parse(raw.trim()) as Partial<OrchestratorResponse>;

  if (!parsed.scenario || !parsed.action || !parsed.phase || !parsed.classification || !parsed.finalSummary) {
    throw new Error("Orchestrator response missing required fields");
  }

  return {
    version: 1,
    scenario: parsed.scenario,
    action: parsed.action,
    phase: parsed.phase,
    classification: {
      size: parsed.classification.size ?? parsed.scenario,
      reason: parsed.classification.reason ?? "No classification reason provided",
      riskLevel: parsed.classification.riskLevel ?? "unknown",
      estimatedTracks: parsed.classification.estimatedTracks ?? 1,
      needsHumanPlanApproval: Boolean(parsed.classification.needsHumanPlanApproval),
    },
    plan: parsed.plan,
    implementation: parsed.implementation,
    review: parsed.review,
    finalSummary: parsed.finalSummary,
    prUrl: parsed.prUrl,
  };
}

export function planApprovalStatusForScenario(
  scenario: keyof typeof TaskScenario,
  action: OrchestrationAction,
): keyof typeof PlanApprovalStatus {
  if (scenario === "COMPLEX" && action === "AWAIT_PLAN_APPROVAL") return "PENDING";
  return "NOT_REQUIRED";
}

function baseInstructions(): string {
  return `You are the orchestrator agent for The Foundry. You must act as a deterministic state machine.

## Hard rules
- Never ask the user for clarification.
- Never return prose outside the JSON response.
- Always emit exactly one JSON object inside a \`\`\`json fenced block.
- Always include: version, scenario, action, phase, classification, finalSummary.
- Scenario values: SMALL | MEDIUM | COMPLEX.
- Action values:
  - COMPLETE: task execution finished successfully.
  - AWAIT_PLAN_APPROVAL: stop after planning and wait for human approval.
  - FAIL: stop because the task cannot continue safely.
- Phase values: CLASSIFY | PLAN | PLAN_DRAFT | WAITING_FOR_PLAN_APPROVAL | IMPLEMENT | REVIEW | REWORK | CREATE_PR | DONE | FAILED.

## Output schema
\`\`\`json
{
  "version": 1,
  "scenario": "SMALL|MEDIUM|COMPLEX",
  "action": "COMPLETE|AWAIT_PLAN_APPROVAL|FAIL",
  "phase": "CLASSIFY|PLAN|PLAN_DRAFT|WAITING_FOR_PLAN_APPROVAL|IMPLEMENT|REVIEW|REWORK|CREATE_PR|DONE|FAILED",
  "classification": {
    "size": "SMALL|MEDIUM|COMPLEX",
    "reason": "why this scenario was chosen",
    "riskLevel": "low|medium|high",
    "estimatedTracks": 1,
    "needsHumanPlanApproval": false
  },
  "plan": {
    "summary": "plan summary",
    "risks": ["optional"],
    "assumptions": ["optional"],
    "rollback": ["optional"],
    "steps": [
      {
        "id": "step-1",
        "title": "step title",
        "files": ["optional"],
        "acceptanceCriteria": "optional",
        "track": "optional",
        "status": "PENDING|IN_PROGRESS|DONE|BLOCKED"
      }
    ]
  },
  "implementation": {
    "summary": "what was implemented",
    "filesChanged": ["optional"],
    "validations": ["optional"],
    "blockers": ["optional"]
  },
  "review": {
    "verdict": "APPROVED|CHANGES_REQUESTED|NOT_RUN",
    "summary": "review result",
    "findings": [
      {
        "severity": "BLOCKER|WARNING|SUGGESTION",
        "file": "optional",
        "detail": "issue details"
      }
    ]
  },
  "finalSummary": "human readable outcome",
  "prUrl": "optional"
}
\`\`\``;
}
