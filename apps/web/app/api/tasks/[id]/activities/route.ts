import { NextResponse } from "next/server";
import { prisma } from "@the-foundry/db";
import { requireApiUser, unauthorizedJson } from "../../../../../lib/auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireApiUser();
  if (!session) return unauthorizedJson();

  const url = new URL(request.url);
  const since = url.searchParams.get("since");
  let sinceFilter: { createdAt: { gt: Date } } | undefined;
  if (since) {
    const sinceDate = new Date(since);
    if (!isNaN(sinceDate.getTime())) {
      sinceFilter = { createdAt: { gt: sinceDate } };
    }
  }

  const activities = await prisma.taskActivity.findMany({
    where: { taskId: id, ...sinceFilter },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(activities);
}
