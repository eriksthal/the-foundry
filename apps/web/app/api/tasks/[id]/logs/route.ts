import { NextResponse } from "next/server";
import { prisma } from "@the-foundry/db";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await request.json()) as {
    event: string;
    toolName?: string;
    toolArgs?: unknown;
    result?: string;
  };

  const log = await prisma.executionLog.create({
    data: {
      taskId: id,
      event: body.event,
      toolName: body.toolName,
      toolArgs: body.toolArgs ? JSON.parse(JSON.stringify(body.toolArgs)) : undefined,
      result: body.result,
    },
  });

  return NextResponse.json(log, { status: 201 });
}
