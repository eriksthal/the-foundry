import { describe, expect, it, vi, beforeEach } from "vitest";
import { ActivityType } from "@the-foundry/db";

// Mock prisma before importing ActivityEmitter
const mockCreate = vi.fn().mockResolvedValue({});
vi.mock("@the-foundry/db", async () => {
  const actual = await vi.importActual("@the-foundry/db");
  return {
    ...actual,
    prisma: {
      taskActivity: {
        create: (...args: unknown[]) => mockCreate(...args),
      },
    },
  };
});

import { ActivityEmitter } from "./activity.js";

describe("ActivityEmitter", () => {
  const taskId = "test-task-id";
  let emitter: ActivityEmitter;

  beforeEach(() => {
    mockCreate.mockClear();
    emitter = new ActivityEmitter(taskId);
  });

  it("emits subagent started and completed with duration", async () => {
    await emitter.emitSubagentStarted("planner");
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId,
        type: ActivityType.SUBAGENT_STARTED,
        title: "planner subagent started",
        metadata: { agentName: "planner" },
      }),
    });

    mockCreate.mockClear();
    // Small delay to ensure durationMs > 0
    await new Promise((r) => setTimeout(r, 10));
    await emitter.emitSubagentCompleted("planner");

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId,
        type: ActivityType.SUBAGENT_COMPLETED,
        title: "planner subagent completed",
        durationMs: expect.any(Number),
      }),
    });
    // Duration should be positive
    const callData = mockCreate.mock.calls[0]![0].data;
    expect(callData.durationMs).toBeGreaterThan(0);
  });

  it("handles subagent completed without prior start", async () => {
    await emitter.emitSubagentCompleted("unknown-agent");
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId,
        type: ActivityType.SUBAGENT_COMPLETED,
        durationMs: undefined,
      }),
    });
  });

  it("emits plan with stepCount in metadata", async () => {
    await emitter.emitPlanGenerated("Do the thing", 5);
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId,
        type: ActivityType.PLAN_GENERATED,
        summary: "Do the thing",
        metadata: { stepCount: 5 },
      }),
    });
  });

  it("emits review with verdict in metadata", async () => {
    await emitter.emitReviewCompleted("APPROVED", "Looks good");
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId,
        type: ActivityType.REVIEW_COMPLETED,
        summary: "Looks good",
        metadata: { verdict: "APPROVED" },
      }),
    });
  });

  it("emits error activity", async () => {
    await emitter.emitError("Something broke");
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId,
        type: ActivityType.ERROR,
        summary: "Something broke",
      }),
    });
  });
});
