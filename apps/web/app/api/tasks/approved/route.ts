import { NextResponse } from "next/server";
import { prisma, TaskStatus } from "@the-foundry/db";

export async function GET() {
  const tasks = await prisma.task.findMany({
    where: { status: TaskStatus.APPROVED },
    include: { project: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(tasks);
}
