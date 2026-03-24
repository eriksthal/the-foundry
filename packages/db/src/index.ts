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
export { TaskStatus, MemoryCategory, MemorySource } from "@prisma/client";

export * as secrets from './secrets';
