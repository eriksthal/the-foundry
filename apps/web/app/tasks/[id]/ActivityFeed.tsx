"use client";

import { useEffect, useRef, useState } from "react";

type Activity = {
  id: string;
  taskId: string;
  type: string;
  title: string;
  summary: string | null;
  metadata: unknown;
  durationMs: number | null;
  createdAt: string;
};

const TYPE_COLORS: Record<string, string> = {
  PHASE_CHANGE: "bg-blue-500",
  SUBAGENT_STARTED: "bg-cyan-500",
  SUBAGENT_COMPLETED: "bg-cyan-700",
  PLAN_GENERATED: "bg-purple-500",
  REVIEW_COMPLETED: "bg-green-500",
  CI_CHECK: "bg-yellow-500",
  ERROR: "bg-red-500",
  TASK_SUMMARY: "bg-emerald-500",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export default function ActivityFeed({
  taskId,
  taskStatus,
  initialActivities,
}: {
  taskId: string;
  taskStatus: string;
  initialActivities: Activity[];
}) {
  const [activities, setActivities] = useState<Activity[]>(initialActivities);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const lastTimestampRef = useRef<string | null>(
    initialActivities.length > 0
      ? initialActivities[initialActivities.length - 1]!.createdAt
      : null,
  );

  useEffect(() => {
    if (taskStatus !== "IN_PROGRESS") return;

    const interval = setInterval(async () => {
      try {
        const params = lastTimestampRef.current
          ? `?since=${encodeURIComponent(lastTimestampRef.current)}`
          : "";
        const res = await fetch(`/api/tasks/${taskId}/activities${params}`);
        if (!res.ok) return;
        const newActivities: Activity[] = await res.json();
        if (newActivities.length > 0) {
          setActivities((prev) => [...prev, ...newActivities]);
          lastTimestampRef.current =
            newActivities[newActivities.length - 1]!.createdAt;
        }
      } catch {
        // Silently ignore fetch errors during polling
      }
    }, 4000);

    return () => clearInterval(interval);
  }, [taskId, taskStatus]);

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  if (activities.length === 0) return null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-400">
          Activity Feed ({activities.length} events)
        </h2>
        {taskStatus === "IN_PROGRESS" && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            Live
          </span>
        )}
      </div>
      <div className="space-y-2">
        {activities.map((activity) => {
          const isExpanded = expandedIds.has(activity.id);
          const colorClass = TYPE_COLORS[activity.type] ?? "bg-zinc-500";

          return (
            <div
              key={activity.id}
              className="rounded border border-zinc-800 bg-zinc-950 p-3 text-xs"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${colorClass}`}
                />
                <span className="font-medium text-zinc-100">
                  {activity.title}
                </span>
                {activity.durationMs != null && (
                  <span className="text-zinc-500">
                    {formatDuration(activity.durationMs)}
                  </span>
                )}
                <span className="ml-auto text-zinc-500">
                  {new Date(activity.createdAt).toLocaleTimeString()}
                </span>
              </div>
              {activity.summary && (
                <div className="mt-1">
                  {isExpanded ? (
                    <p className="whitespace-pre-wrap text-zinc-400">
                      {activity.summary}
                    </p>
                  ) : (
                    <p className="text-zinc-400">
                      {activity.summary.length > 120
                        ? activity.summary.slice(0, 120) + "…"
                        : activity.summary}
                    </p>
                  )}
                  {activity.summary.length > 120 && (
                    <button
                      onClick={() => toggleExpanded(activity.id)}
                      className="mt-1 text-blue-400 hover:text-blue-300"
                    >
                      {isExpanded ? "Show less" : "Show more"}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
