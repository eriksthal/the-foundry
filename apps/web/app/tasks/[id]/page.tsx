import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@the-foundry/db";

export const dynamic = "force-dynamic";

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-zinc-700",
  PENDING_APPROVAL: "bg-yellow-700",
  APPROVED: "bg-blue-700",
  IN_PROGRESS: "bg-purple-700",
  COMPLETED: "bg-green-700",
  FAILED: "bg-red-700",
};

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      project: true,
      logs: { orderBy: { timestamp: "asc" } },
      feedback: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!task) notFound();

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
            {task.status.replace("_", " ")}
          </span>
        </div>
      </div>

      {/* Description */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <h2 className="mb-2 text-sm font-semibold text-zinc-400">Description</h2>
        <p className="whitespace-pre-wrap text-sm">{task.description}</p>
      </div>

      {/* Result */}
      {task.result && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="mb-2 text-sm font-semibold text-zinc-400">Result</h2>
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

      {/* Error Log */}
      {task.errorLog && (
        <div className="rounded-lg border border-red-900 bg-red-950 p-5">
          <h2 className="mb-2 text-sm font-semibold text-red-400">Error</h2>
          <pre className="whitespace-pre-wrap text-xs text-red-300">{task.errorLog}</pre>
        </div>
      )}

      {/* Execution Timeline */}
      {task.logs.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="mb-3 text-sm font-semibold text-zinc-400">
            Execution Log ({task.logs.length} events)
          </h2>
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {task.logs.map((log) => (
              <div key={log.id} className="flex gap-3 text-xs">
                <span className="shrink-0 text-zinc-500">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span className="font-mono text-zinc-300">{log.event}</span>
                {log.toolName && <span className="text-blue-400">{log.toolName}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Metadata */}
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
        {task.completedAt && (
          <div>
            <span className="block text-zinc-600">Completed</span>
            {task.completedAt.toLocaleString()}
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
