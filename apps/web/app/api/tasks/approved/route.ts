import { NextResponse } from "next/server";
import { prisma, TaskStatus } from "@the-foundry/db";
import { requireApiUser, unauthorizedJson } from "../../../../lib/auth";

export async function GET() {
  const session = await requireApiUser();
  if (!session) return unauthorizedJson();

  const tasks = await prisma.task.findMany({
    where: { status: TaskStatus.APPROVED },
    include: { project: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(tasks);
}
