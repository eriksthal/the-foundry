import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import {
  PlanApprovalStatus,
  prisma,
  TaskPhase,
  TaskStatus,
} from "@the-foundry/db";

import { requireUser } from "../../../lib/auth";

export const dynamic = "force-dynamic";

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-zinc-700",
  PENDING_APPROVAL: "bg-yellow-700",
  APPROVED: "bg-blue-700",
  IN_PROGRESS: "bg-purple-700",
  WAITING_FOR_PLAN_APPROVAL: "bg-orange-700",
  COMPLETED: "bg-green-700",
  FAILED: "bg-red-700",
};

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireUser(`/tasks/${id}`);

  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      project: true,
      logs: { orderBy: { timestamp: "asc" } },
      feedback: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!task) notFound();

  async function approvePlan() {
    "use server";
    await requireUser(`/tasks/${id}`);

    await prisma.$transaction([
      prisma.task.update({
        where: { id },
        data: {
          status: TaskStatus.APPROVED,
          planApprovalStatus: PlanApprovalStatus.APPROVED,
          phase: TaskPhase.WAITING_FOR_PLAN_APPROVAL,
          errorLog: null,
          lastActivityAt: new Date(),
        },
      }),
      prisma.executionLog.create({
        data: {
          taskId: id,
          event: "plan.approved",
          phase: TaskPhase.WAITING_FOR_PLAN_APPROVAL,
          result: "Plan approved from dashboard",
        },
      }),
    ]);

    redirect(`/tasks/${id}`);
  }

  async function rejectPlan(formData: FormData) {
    "use server";
    await requireUser(`/tasks/${id}`);

    const reason = String(formData.get("reason") || "Plan rejected from dashboard.");

    await prisma.$transaction([
      prisma.task.update({
        where: { id },
        data: {
          status: TaskStatus.FAILED,
          planApprovalStatus: PlanApprovalStatus.REJECTED,
          phase: TaskPhase.FAILED,
          errorLog: reason,
          completedAt: new Date(),
        },
      }),
      prisma.executionLog.create({
        data: {
          taskId: id,
          event: "plan.rejected",
          phase: TaskPhase.FAILED,
          result: reason,
        },
      }),
    ]);

    redirect(`/tasks/${id}`);
  }

  const plan = isPlan(task.planContent) ? task.planContent : null;
  const timelineLogs = task.logs.filter((log) => !log.event.startsWith("assistant.message_delta"));

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/projects/${task.projectId}`}
          className="text-sm text-zinc-400 hover:text-zinc-200"
        >
          &larr; {task.project.name}
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-bold">{task.title}</h1>
          <span
            className={`rounded px-2 py-0.5 text-xs ${STATUS_COLORS[task.status] ?? "bg-zinc-700"}`}
          >
            {task.status.replaceAll("_", " ")}
          </span>
        </div>
        <p className="mt-2 text-sm text-zinc-400">{task.description}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <InfoCard label="Scenario" value={task.scenario ?? "Unclassified"} />
        <InfoCard label="Phase" value={task.phase ?? "Not started"} />
        <InfoCard label="Plan Approval" value={task.planApprovalStatus} />
        <InfoCard
          label="Tracks"
          value={typeof task.estimatedTracks === "number" ? String(task.estimatedTracks) : "n/a"}
        />
      </div>

      {task.classificationReason && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="mb-2 text-sm font-semibold text-zinc-400">Classification</h2>
          <p className="text-sm text-zinc-200">{task.classificationReason}</p>
          {task.riskLevel && (
            <p className="mt-2 text-xs text-zinc-500">Risk level: {task.riskLevel}</p>
          )}
        </div>
      )}

      {plan && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-zinc-400">Execution Plan</h2>
              <p className="mt-1 text-sm text-zinc-200">{plan.summary}</p>
            </div>
            {task.status === "WAITING_FOR_PLAN_APPROVAL" && (
              <form action={approvePlan}>
                <button
                  type="submit"
                  className="rounded bg-green-700 px-3 py-2 text-sm hover:bg-green-600"
                >
                  Approve Plan
                </button>
              </form>
            )}
          </div>

          {plan.steps && plan.steps.length > 0 && (
            <div className="mt-4 space-y-3">
              {plan.steps.map((step) => (
                <div key={step.id} className="rounded border border-zinc-800 bg-zinc-950 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">{step.title}</p>
                    {step.status && (
                      <span className="text-xs text-zinc-500">{step.status}</span>
                    )}
                  </div>
                  {step.acceptanceCriteria && (
                    <p className="mt-1 text-sm text-zinc-400">{step.acceptanceCriteria}</p>
                  )}
                  {step.files && step.files.length > 0 && (
                    <p className="mt-2 text-xs text-zinc-500">
                      Files: {step.files.join(", ")}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {task.status === "WAITING_FOR_PLAN_APPROVAL" && (
            <form action={rejectPlan} className="mt-4 space-y-3">
              <textarea
                name="reason"
                rows={3}
                defaultValue="Plan rejected from dashboard."
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
              />
              <button
                type="submit"
                className="rounded bg-red-700 px-3 py-2 text-sm hover:bg-red-600"
              >
                Reject Plan
              </button>
            </form>
          )}
        </div>
      )}

      {task.result && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="mb-2 text-sm font-semibold text-zinc-400">Latest Outcome</h2>
          <p className="whitespace-pre-wrap text-sm">{task.result}</p>
          {task.prUrl && (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-sm text-blue-400 hover:underline"
            >
              View Pull Request &rarr;
            </a>
          )}
        </div>
      )}

      {task.errorLog && (
        <div className="rounded-lg border border-red-900 bg-red-950 p-5">
          <h2 className="mb-2 text-sm font-semibold text-red-400">Error</h2>
          <pre className="whitespace-pre-wrap text-xs text-red-300">{task.errorLog}</pre>
        </div>
      )}

      {timelineLogs.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="mb-3 text-sm font-semibold text-zinc-400">
            Execution Timeline ({timelineLogs.length} events)
          </h2>
          <div className="max-h-[32rem] space-y-2 overflow-y-auto">
            {timelineLogs.map((log) => (
              <div key={log.id} className="rounded border border-zinc-800 bg-zinc-950 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-zinc-500">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span className="font-mono text-zinc-200">{log.event}</span>
                  {log.phase && <span className="text-orange-300">{log.phase}</span>}
                  {log.agentName && <span className="text-cyan-300">{log.agentName}</span>}
                  {log.toolName && <span className="text-blue-400">{log.toolName}</span>}
                </div>
                {log.result && (
                  <p className="mt-2 whitespace-pre-wrap text-zinc-400">{log.result}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 text-xs text-zinc-500 sm:grid-cols-4">
        <div>
          <span className="block text-zinc-600">Created</span>
          {task.createdAt.toLocaleString()}
        </div>
        {task.startedAt && (
          <div>
            <span className="block text-zinc-600">Started</span>
            {task.startedAt.toLocaleString()}
          </div>
        )}
        {task.lastActivityAt && (
          <div>
            <span className="block text-zinc-600">Last Activity</span>
            {task.lastActivityAt.toLocaleString()}
          </div>
        )}
        {task.branch && (
          <div>
            <span className="block text-zinc-600">Branch</span>
            {task.branch}
          </div>
        )}
      </div>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-2 text-sm text-zinc-100">{value}</p>
    </div>
  );
}

type PlanShape = {
  summary: string;
  steps?: Array<{
    id: string;
    title: string;
    files?: string[];
    acceptanceCriteria?: string;
    status?: string;
  }>;
};

function isPlan(value: unknown): value is PlanShape {
  return typeof value === "object" && value !== null && "summary" in value;
}
