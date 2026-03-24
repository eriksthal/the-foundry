import { NextResponse } from "next/server";
import { prisma, type TaskStatus } from "@the-foundry/db";
import { requireApiUser, unauthorizedJson } from "../../../../lib/auth";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireApiUser();
  if (!session) return unauthorizedJson();

  const { id } = await params;
  const body = (await request.json()) as {
    status?: TaskStatus;
    result?: string;
    errorLog?: string;
    prUrl?: string;
    branch?: string;
  };

  const data: Record<string, unknown> = {};

  if (body.status) data.status = body.status;
  if (body.result) data.result = body.result;
  if (body.errorLog) data.errorLog = body.errorLog;
  if (body.prUrl) data.prUrl = body.prUrl;
  if (body.branch) data.branch = body.branch;

  if (body.status === "IN_PROGRESS") data.startedAt = new Date();
  if (body.status === "COMPLETED" || body.status === "FAILED") data.completedAt = new Date();

  const task = await prisma.task.update({ where: { id }, data });

  return NextResponse.json(task);
}
