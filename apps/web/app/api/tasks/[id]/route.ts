import { NextResponse } from "next/server";
import {
  PlanApprovalStatus,
  prisma,
  TaskPhase,
  TaskScenario,
  type TaskStatus,
} from "@the-foundry/db";
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
    scenario?: TaskScenario;
    phase?: TaskPhase;
    classificationReason?: string;
    riskLevel?: string;
    estimatedTracks?: number;
    planApprovalStatus?: PlanApprovalStatus;
    planContent?: unknown;
    copilotSessionId?: string;
    copilotWorkspacePath?: string;
    workingDirectory?: string;
    result?: string;
    errorLog?: string;
    prUrl?: string;
    branch?: string;
  };

  const data: Record<string, unknown> = {};

  if (body.status) data.status = body.status;
  if (body.scenario) data.scenario = body.scenario;
  if (body.phase) data.phase = body.phase;
  if (body.classificationReason) data.classificationReason = body.classificationReason;
  if (body.riskLevel) data.riskLevel = body.riskLevel;
  if (typeof body.estimatedTracks === "number") data.estimatedTracks = body.estimatedTracks;
  if (body.planApprovalStatus) data.planApprovalStatus = body.planApprovalStatus;
  if (body.planContent) data.planContent = JSON.parse(JSON.stringify(body.planContent));
  if (body.copilotSessionId) data.copilotSessionId = body.copilotSessionId;
  if (body.copilotWorkspacePath) data.copilotWorkspacePath = body.copilotWorkspacePath;
  if (body.workingDirectory) data.workingDirectory = body.workingDirectory;
  if (body.result) data.result = body.result;
  if (body.errorLog) data.errorLog = body.errorLog;
  if (body.prUrl) data.prUrl = body.prUrl;
  if (body.branch) data.branch = body.branch;

  if (body.status === "IN_PROGRESS") data.startedAt = new Date();
  if (body.status === "COMPLETED" || body.status === "FAILED") data.completedAt = new Date();

  const task = await prisma.task.update({ where: { id }, data });

  return NextResponse.json(task);
}
