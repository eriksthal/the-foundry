import Link from "next/link";
import { prisma } from "@the-foundry/db";

import { requireUser } from "../lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  await requireUser("/");

  const [projectCount, taskCounts] = await Promise.all([
    prisma.project.count(),
    prisma.task.groupBy({
      by: ["status"],
      _count: { id: true },
    }),
  ]);

  const statusMap = Object.fromEntries(
    taskCounts.map((t) => [t.status, t._count.id]),
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="mt-2 text-zinc-400">AI task orchestration control panel</p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Projects" value={projectCount} />
        <StatCard label="Approved" value={statusMap["APPROVED"] ?? 0} />
        <StatCard label="In Progress" value={statusMap["IN_PROGRESS"] ?? 0} />
        <StatCard label="Completed" value={statusMap["COMPLETED"] ?? 0} />
      </div>

      <div className="flex gap-4">
        <Link
          href="/projects"
          className="rounded-lg bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
        >
          View Projects
        </Link>
        <Link
          href="/projects/new"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-500"
        >
          New Project
        </Link>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-sm text-zinc-400">{label}</div>
    </div>
  );
}
