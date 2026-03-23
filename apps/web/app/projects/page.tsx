import Link from "next/link";
import { prisma } from "@the-foundry/db";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const projects = await prisma.project.findMany({
    include: {
      _count: { select: { tasks: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Projects</h1>
        <Link
          href="/projects/new"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-500"
        >
          New Project
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-zinc-400">
          No projects yet. Create one to get started.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="rounded-lg border border-zinc-800 bg-zinc-900 p-5 hover:border-zinc-700"
            >
              <h2 className="font-semibold">{project.name}</h2>
              {project.description && (
                <p className="mt-1 text-sm text-zinc-400 line-clamp-2">
                  {project.description}
                </p>
              )}
              <div className="mt-3 flex items-center gap-3 text-xs text-zinc-500">
                <span>{project._count.tasks} tasks</span>
                <span className="truncate">{project.repoUrl}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
