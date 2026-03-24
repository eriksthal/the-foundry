import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from repository root (services/worker may run with cwd inside the package)
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

function maskToken(t?: string | null) {
  if (!t) return '<missing>';
  if (t.length <= 8) return `${t.slice(0, 2)}...${t.slice(-2)}`;
  return `${t.slice(0, 4)}...${t.slice(-4)}`;
}

console.info('[worker] GITHUB_TOKEN present:', Boolean(process.env.GITHUB_TOKEN), 'value:', maskToken(process.env.GITHUB_TOKEN));
console.info('[worker] COPILOT_GITHUB_TOKEN present:', Boolean(process.env.COPILOT_GITHUB_TOKEN), 'value:', maskToken(process.env.COPILOT_GITHUB_TOKEN));

import { prisma, TaskStatus } from "@the-foundry/db";
import { processTask } from "./runner.js";

const POLL_INTERVAL_MS = 10_000;

async function pollForTasks(): Promise<void> {
  const tasks = await prisma.task.findMany({
    where: { status: TaskStatus.APPROVED },
    include: { project: true },
    orderBy: { createdAt: "asc" },
    take: 1,
  });

  if (tasks.length === 0) return;

  const task = tasks[0]!;
  console.info(`[worker] Processing task: ${task.title} (${task.id})`);

  try {
    await prisma.task.update({
      where: { id: task.id },
      data: { status: TaskStatus.IN_PROGRESS, startedAt: new Date(), lastActivityAt: new Date() },
    });

    await processTask(task, task.project);

    await prisma.task.update({
      where: { id: task.id },
      data: { status: TaskStatus.COMPLETED, completedAt: new Date() },
    });

    console.info(`[worker] Task completed: ${task.id}`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[worker] Task failed: ${task.id}`, errorMsg);

    await prisma.task.update({
      where: { id: task.id },
      data: {
        status: TaskStatus.FAILED,
        errorLog: errorMsg,
        completedAt: new Date(),
      },
    });
  }
}

async function main(): Promise<void> {
  console.info("[worker] The Foundry worker started");
  console.info(`[worker] Polling every ${POLL_INTERVAL_MS / 1000}s`);

  // Run immediately, then poll
  await pollForTasks();

  setInterval(() => {
    pollForTasks().catch((err) => {
      console.error("[worker] Poll error:", err);
    });
  }, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[worker] Fatal error:", err);
  process.exit(1);
});
