import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export { PrismaClient };
export type { Project, Task, ExecutionLog, ProjectMemory, TaskFeedback, TaskActivity } from "@prisma/client";

export const TaskStatus = {
  DRAFT: "DRAFT",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  APPROVED: "APPROVED",
  IN_PROGRESS: "IN_PROGRESS",
  WAITING_FOR_PLAN_APPROVAL: "WAITING_FOR_PLAN_APPROVAL",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TaskScenario = {
  SMALL: "SMALL",
  MEDIUM: "MEDIUM",
  COMPLEX: "COMPLEX",
} as const;

export type TaskScenario = (typeof TaskScenario)[keyof typeof TaskScenario];

export const PlanApprovalStatus = {
  NOT_REQUIRED: "NOT_REQUIRED",
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
} as const;

export type PlanApprovalStatus =
  (typeof PlanApprovalStatus)[keyof typeof PlanApprovalStatus];

export const TaskPhase = {
  CLASSIFY: "CLASSIFY",
  PLAN: "PLAN",
  PLAN_DRAFT: "PLAN_DRAFT",
  WAITING_FOR_PLAN_APPROVAL: "WAITING_FOR_PLAN_APPROVAL",
  IMPLEMENT: "IMPLEMENT",
  REVIEW: "REVIEW",
  REWORK: "REWORK",
  CREATE_PR: "CREATE_PR",
  DONE: "DONE",
  FAILED: "FAILED",
} as const;

export type TaskPhase = (typeof TaskPhase)[keyof typeof TaskPhase];

export const MemoryCategory = {
  PATTERN: "PATTERN",
  MISTAKE: "MISTAKE",
  CONVENTION: "CONVENTION",
  GOTCHA: "GOTCHA",
} as const;

export type MemoryCategory = (typeof MemoryCategory)[keyof typeof MemoryCategory];

export const MemorySource = {
  HUMAN_FEEDBACK: "HUMAN_FEEDBACK",
  AUTO_DETECTED: "AUTO_DETECTED",
  MANUAL: "MANUAL",
} as const;

export type MemorySource = (typeof MemorySource)[keyof typeof MemorySource];

export const ActivityType = {
  PHASE_CHANGE: "PHASE_CHANGE",
  SUBAGENT_STARTED: "SUBAGENT_STARTED",
  SUBAGENT_COMPLETED: "SUBAGENT_COMPLETED",
  PLAN_GENERATED: "PLAN_GENERATED",
  REVIEW_COMPLETED: "REVIEW_COMPLETED",
  CI_CHECK: "CI_CHECK",
  ERROR: "ERROR",
  TASK_SUMMARY: "TASK_SUMMARY",
} as const;

export type ActivityType = (typeof ActivityType)[keyof typeof ActivityType];

export const SUPPORTED_MODELS = [
  { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6", description: "Strong tool use, balanced" },
  { id: "claude-opus-4.6", label: "Claude Opus 4.6", description: "Most capable, complex tasks" },
  { id: "gpt-4.1", label: "GPT-4.1", description: "Fast, cost-effective" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 Mini", description: "Fastest, cheapest" },
  { id: "gpt-4.1-nano", label: "GPT-4.1 Nano", description: "Ultra-fast, lowest cost" },
  { id: "o3", label: "o3", description: "Advanced reasoning" },
  { id: "o4-mini", label: "o4-mini", description: "Fast reasoning" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", description: "Google, strong reasoning" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", description: "Google, fast and efficient" },
] as const;

export const DEFAULT_MODEL = "claude-sonnet-4.6" as const;

export * as secrets from "./secrets.ts";
