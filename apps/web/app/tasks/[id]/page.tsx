import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import {
  type ExecutionLog,
  PlanApprovalStatus,
  prisma,
  TaskPhase,
  TaskStatus,
} from "@the-foundry/db";

import { requireUser } from "../../../lib/auth";
import { getPullRequestState } from "../../../lib/github";
import ActivityFeed from "./ActivityFeed";

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

  const [task, activities] = await Promise.all([
    prisma.task.findUnique({
      where: { id },
      include: {
        project: true,
        logs: { orderBy: { timestamp: "asc" } },
        feedback: { orderBy: { createdAt: "desc" } },
      },
    }),
    prisma.taskActivity.findMany({
      where: { taskId: id },
      orderBy: { createdAt: "asc" },
    }),
  ]);

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
  const pullRequest = task.prUrl ? await getPullRequestState(task.prUrl) : null;
  const runSummary = buildRunSummary(timelineLogs, task);
  const categorizedTimeline = categorizeLogs(timelineLogs);

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
        <InfoCard label="Model" value={task.model} />
      </div>

      {task.classificationReason && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="mb-2 text-sm font-semibold text-zinc-400">Classification</h2>
          <p className="text-sm text-zinc-200">{task.classificationReason}</p>
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
          {!task.prUrl && task.status === "COMPLETED" && (
            <p className="mt-3 text-sm text-yellow-300">
              No pull request is associated with this completed task.
            </p>
          )}
          {task.prUrl && (
            <div className="mt-3 space-y-2">
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-sm text-blue-400 hover:underline"
              >
                View Pull Request &rarr;
              </a>
              {pullRequest && (
                <div className="rounded border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300">
                  <p>
                    PR #{pullRequest.number} · {pullRequest.merged ? "Merged" : pullRequest.state}
                  </p>
                  {pullRequest.mergedAt && (
                    <p className="mt-1 text-zinc-500">
                      Merged at {new Date(pullRequest.mergedAt).toLocaleString()}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {task.errorLog && (
        <div className="rounded-lg border border-red-900 bg-red-950 p-5">
          <h2 className="mb-2 text-sm font-semibold text-red-400">Error</h2>
          <pre className="whitespace-pre-wrap text-xs text-red-300">{task.errorLog}</pre>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {runSummary.map((item) => (
          <InfoCard key={item.label} label={item.label} value={item.value} />
        ))}
      </div>

      {(activities.length > 0 || task.status === "IN_PROGRESS") && (
        <ActivityFeed
          taskId={id}
          taskStatus={task.status}
          initialActivities={activities.map((a) => ({
            ...a,
            createdAt: a.createdAt.toISOString(),
          }))}
        />
      )}

      {timelineLogs.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="mb-3 text-sm font-semibold text-zinc-400">
            Execution Timeline ({timelineLogs.length} events)
          </h2>
          <div className="space-y-5">
            {categorizedTimeline.map((section) => (
              <div key={section.category} className="rounded border border-zinc-800 bg-zinc-950 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-medium text-zinc-100">{section.label}</h3>
                    <p className="text-xs text-zinc-500">{section.description}</p>
                  </div>
                  <span className="rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-400">
                    {section.logs.length} events
                  </span>
                </div>

                <div className="max-h-72 space-y-2 overflow-y-auto">
                  {section.logs.map((log) => (
                    <div key={log.id} className="rounded border border-zinc-800 bg-zinc-900 p-3 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-zinc-500">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </span>
                        <span className="font-mono text-zinc-200">{formatEventLabel(log)}</span>
                        {log.phase && <span className="text-orange-300">{log.phase}</span>}
                        {log.agentName && <span className="text-cyan-300">{log.agentName}</span>}
                        {log.toolName && <span className="text-blue-400">{log.toolName}</span>}
                      </div>
                      {log.result && (
                        <p className="mt-2 whitespace-pre-wrap text-zinc-400">
                          {truncateLogResult(log.result)}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
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

type TimelineSection = {
  category: LogCategory;
  label: string;
  description: string;
  logs: ExecutionLog[];
};

type LogCategory =
  | "planning"
  | "resume"
  | "environment"
  | "exploration"
  | "implementation"
  | "validation"
  | "delivery"
  | "problems"
  | "other";

function buildRunSummary(logs: ExecutionLog[], task: { status: string; prUrl: string | null }) {
  const lastResumeEvent = [...logs]
    .reverse()
    .find((log) => ["plan.resume", "plan.resume_fallback", "plan.resume_failed"].includes(log.event));
  const editEvents = logs.filter(
    (log) =>
      (log.event === "tool_call" || log.event === "tool_result") &&
      ["write_file", "edit_file"].includes(log.toolName ?? ""),
  );
  const deliveryEvent = [...logs]
    .reverse()
    .find((log) => ["pr.synced", "pr.unavailable", "pr.skipped", "git.no_changes"].includes(log.event));
  const reviewEvent = [...logs].reverse().find((log) => log.event === "review.completed");

  return [
    {
      label: "Resume",
      value: summarizeResume(lastResumeEvent),
    },
    {
      label: "Code Changes",
      value: editEvents.length > 0 ? `${editEvents.length} edit events recorded` : "No edit tools recorded",
    },
    {
      label: "Review",
      value: reviewEvent?.result ? truncateSingleLine(reviewEvent.result, 48) : "No review completion recorded",
    },
    {
      label: "Delivery",
      value: summarizeDelivery(deliveryEvent, task.prUrl, task.status),
    },
  ];
}

function categorizeLogs(logs: ExecutionLog[]): TimelineSection[] {
  const order: LogCategory[] = [
    "planning",
    "resume",
    "environment",
    "exploration",
    "implementation",
    "validation",
    "delivery",
    "problems",
    "other",
  ];

  const groups = new Map<LogCategory, ExecutionLog[]>();
  for (const log of logs) {
    const category = categorizeLog(log);
    const existing = groups.get(category) ?? [];
    existing.push(log);
    groups.set(category, existing);
  }

  return order
    .map((category) => {
      const categoryLogs = groups.get(category) ?? [];
      if (categoryLogs.length === 0) return null;

      return {
        category,
        label: categoryLabel(category),
        description: categoryDescription(category),
        logs: categoryLogs,
      } satisfies TimelineSection;
    })
    .filter((section): section is TimelineSection => Boolean(section));
}

function categorizeLog(log: ExecutionLog): LogCategory {
  if (isProblemLog(log)) return "problems";
  if (log.event.startsWith("classification.") || log.event.startsWith("plan.")) {
    return log.event.startsWith("plan.resume") ? "resume" : "planning";
  }
  if (log.event === "setup" || log.event === "setup_error" || log.event === "secrets_injection") {
    return "environment";
  }
  if (log.event === "review.completed") return "validation";
  if (log.event.startsWith("git.") || log.event.startsWith("pr.")) return "delivery";

  if (log.event === "tool_call" || log.event === "tool_result") {
    if (["write_file", "edit_file"].includes(log.toolName ?? "")) return "implementation";
    if (["run", "git"].includes(log.toolName ?? "")) return "validation";
    if (["read_file", "search", "list_dir", "glob", "grep"].includes(log.toolName ?? "")) {
      return "exploration";
    }
  }

  return "other";
}

function isProblemLog(log: ExecutionLog): boolean {
  return [
    "setup_error",
    "plan.resume_failed",
    "pr.skipped",
    "pr.unavailable",
    "git.no_changes",
  ].includes(log.event);
}

function categoryLabel(category: LogCategory): string {
  switch (category) {
    case "planning":
      return "Planning";
    case "resume":
      return "Resume";
    case "environment":
      return "Environment";
    case "exploration":
      return "Repo Exploration";
    case "implementation":
      return "Code Changes";
    case "validation":
      return "Validation";
    case "delivery":
      return "Git & PR";
    case "problems":
      return "Problems";
    default:
      return "Other";
  }
}

function categoryDescription(category: LogCategory): string {
  switch (category) {
    case "planning":
      return "Classification, plan generation, and approval checkpoints.";
    case "resume":
      return "Whether the approved plan resumed cleanly or had to restart.";
    case "environment":
      return "Repository setup, dependency install, and secrets loading.";
    case "exploration":
      return "Read/search/list activity while the agent inspected the repo.";
    case "implementation":
      return "Actual file editing and code-writing activity.";
    case "validation":
      return "Runs, reviews, and post-change verification.";
    case "delivery":
      return "Diff detection, commits, pushes, and pull request work.";
    case "problems":
      return "Why the task stalled, skipped work, or failed.";
    default:
      return "Events that did not fit the main buckets.";
  }
}

function summarizeResume(log?: ExecutionLog): string {
  if (!log) return "No resume event";
  if (log.event === "plan.resume") return "Resumed approved session";
  if (log.event === "plan.resume_fallback") return "Restarted from approved plan";
  if (log.event === "plan.resume_failed") return "Resume failed";
  return log.event;
}

function summarizeDelivery(log: ExecutionLog | undefined, prUrl: string | null, status: string): string {
  if (prUrl) return "PR attached";
  if (log?.event === "git.no_changes") return "No diff detected";
  if (log?.event === "pr.unavailable") return "Push succeeded, PR missing";
  if (log?.event === "pr.skipped") return "PR skipped";
  if (status === "FAILED") return "Failed before delivery";
  return "No delivery signal";
}

function formatEventLabel(log: ExecutionLog): string {
  if ((log.event === "tool_call" || log.event === "tool_result") && log.toolName) {
    return `${log.event}.${log.toolName}`;
  }
  return log.event;
}

function truncateLogResult(result: string): string {
  return truncateSingleLine(result, 220);
}

function truncateSingleLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}
