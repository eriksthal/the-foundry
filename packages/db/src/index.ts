import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export { PrismaClient };
export type { Project, Task, ExecutionLog, ProjectMemory, TaskFeedback } from "@prisma/client";

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

export * as secrets from './secrets';
