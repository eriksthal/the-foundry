import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { prisma, TaskStatus } from "@the-foundry/db";

import { requireUser } from "../../../lib/auth";
import { SecretsSection } from "./SecretsSection";

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

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireUser(`/projects/${id}`);

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      tasks: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!project) notFound();

  async function createTask(formData: FormData) {
    "use server";
    await requireUser(`/projects/${id}`);
    const title = formData.get("title") as string;
    const description = formData.get("description") as string;

    if (!title?.trim() || !description?.trim()) {
      throw new Error("Title and description are required");
    }

    await prisma.task.create({
      data: {
        projectId: id,
        title: title.trim(),
        description: description.trim(),
        status: TaskStatus.DRAFT,
      },
    });

    redirect(`/projects/${id}`);
  }

  async function approveTask(formData: FormData) {
    "use server";
    await requireUser(`/projects/${id}`);
    const taskId = formData.get("taskId") as string;
    await prisma.task.update({
      where: { id: taskId },
      data: { status: TaskStatus.APPROVED },
    });

    redirect(`/projects/${id}`);
  }

  async function submitForApproval(formData: FormData) {
    "use server";
    await requireUser(`/projects/${id}`);
    const taskId = formData.get("taskId") as string;
    await prisma.task.update({
      where: { id: taskId },
      data: { status: TaskStatus.PENDING_APPROVAL },
    });

    redirect(`/projects/${id}`);
  }

  return (
    <div className="space-y-8">
      <div>
        <Link href="/projects" className="text-sm text-zinc-400 hover:text-zinc-200">
          &larr; Projects
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{project.name}</h1>
        {project.description && <p className="mt-1 text-zinc-400">{project.description}</p>}
        <p className="mt-1 text-xs text-zinc-500">{project.repoUrl}</p>
      </div>

      {/* Create Task Form */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <h2 className="mb-4 font-semibold">New Task</h2>
        <form action={createTask} className="space-y-3">
          <input
            name="title"
            required
            placeholder="Task title"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
          />
          <textarea
            name="description"
            required
            rows={4}
            placeholder="Describe what the agent should do. Be specific about the expected changes, files involved, and success criteria."
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-500"
          >
            Create Task
          </button>
        </form>
      </div>

      {/* Secrets Management Section */}
      <SecretsSection project={project} />

      {/* Task List */}
      <div className="space-y-3">
        <h2 className="font-semibold">Tasks ({project.tasks.length})</h2>
        {project.tasks.length === 0 ? (
          <p className="text-sm text-zinc-500">No tasks yet.</p>
        ) : (
          project.tasks.map((task) => (
            <div
              key={task.id}
              className="flex items-start justify-between rounded-lg border border-zinc-800 bg-zinc-900 p-4"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/tasks/${task.id}`}
                    className="font-medium hover:text-blue-400"
                  >
                    {task.title}
                  </Link>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${STATUS_COLORS[task.status] ?? "bg-zinc-700"}`}
                  >
                    {task.status.replace("_", " ")}
                  </span>
                </div>
                <p className="text-sm text-zinc-400 line-clamp-2">{task.description}</p>
                {task.scenario && (
                  <p className="text-xs text-zinc-500">
                    Scenario: {task.scenario} {task.phase ? `· Phase: ${task.phase}` : ""}
                  </p>
                )}
                {task.status === "WAITING_FOR_PLAN_APPROVAL" && (
                  <p className="text-xs text-orange-300">
                    Plan is ready for review in the task detail view.
                  </p>
                )}
                {task.prUrl && (
                  <a
                    href={task.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:underline"
                  >
                    View PR
                  </a>
                )}
              </div>
              <div className="ml-4 flex shrink-0 gap-2">
                {task.status === "DRAFT" && (
                  <form action={submitForApproval}>
                    <input type="hidden" name="taskId" value={task.id} />
                    <button
                      type="submit"
                      className="rounded bg-yellow-700 px-3 py-1 text-xs hover:bg-yellow-600"
                    >
                      Submit
                    </button>
                  </form>
                )}
                {task.status === "PENDING_APPROVAL" && (
                  <form action={approveTask}>
                    <input type="hidden" name="taskId" value={task.id} />
                    <button
                      type="submit"
                      className="rounded bg-green-700 px-3 py-1 text-xs hover:bg-green-600"
                    >
                      Approve
                    </button>
                  </form>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
