import { PrismaClient } from "@prisma/client";

const taskId = process.argv[2];
if (!taskId) {
  console.error("Usage: node scripts/queryTask.mjs <taskId>");
  process.exit(1);
}

const p = new PrismaClient();

try {
  const task = await p.task.findUnique({
    where: { id: taskId },
    include: { project: true },
  });

  if (!task) {
    console.error("Task not found:", taskId);
    process.exit(1);
  }

  console.log("=== TASK ===");
  console.log(JSON.stringify({
    title: task.title,
    description: task.description?.slice(0, 500),
    status: task.status,
    phase: task.phase,
    scenario: task.scenario,
    errorLog: task.errorLog?.slice(0, 2000),
    result: task.result?.slice(0, 2000),
    classificationReason: task.classificationReason,
    planApprovalStatus: task.planApprovalStatus,
    branch: task.branch,
    prUrl: task.prUrl,
    project: task.project?.name,
  }, null, 2));

  const logs = await p.executionLog.findMany({
    where: { taskId },
    orderBy: { timestamp: "asc" },
  });

  console.log(`\n=== LOGS (${logs.length}) ===`);
  for (const log of logs) {
    const ts = log.timestamp.toISOString().slice(11, 19);
    const result = (log.result || "").replace(/\s+/g, " ").slice(0, 250);
    console.log(`${ts} | ${log.event} | ${log.agentName || "-"} | ${log.toolName || "-"} | ${result}`);
  }

  const activities = await p.taskActivity.findMany({
    where: { taskId },
    orderBy: { createdAt: "asc" },
  });

  console.log(`\n=== ACTIVITIES (${activities.length}) ===`);
  for (const a of activities) {
    const ts = a.createdAt.toISOString().slice(11, 19);
    const summary = (a.summary || "").replace(/\s+/g, " ").slice(0, 250);
    console.log(`${ts} | ${a.type} | ${a.title} | ${summary}`);
  }
} finally {
  await p.$disconnect();
}
