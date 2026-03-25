import { ActivityType, prisma } from "@the-foundry/db";

export class ActivityEmitter {
  private readonly taskId: string;
  private readonly subagentStartTimes = new Map<string, number>();

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  async emitPhaseChange(title: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.createActivity({ type: ActivityType.PHASE_CHANGE, title, metadata });
  }

  async emitSubagentStarted(agentName: string): Promise<void> {
    this.subagentStartTimes.set(agentName, Date.now());
    await this.createActivity({
      type: ActivityType.SUBAGENT_STARTED,
      title: `${agentName} subagent started`,
      metadata: { agentName },
    });
  }

  async emitSubagentCompleted(agentName: string, summary?: string): Promise<void> {
    const startTime = this.subagentStartTimes.get(agentName);
    const durationMs = startTime != null ? Date.now() - startTime : undefined;
    this.subagentStartTimes.delete(agentName);
    await this.createActivity({
      type: ActivityType.SUBAGENT_COMPLETED,
      title: `${agentName} subagent completed`,
      summary,
      metadata: { agentName },
      durationMs,
    });
  }

  async emitPlanGenerated(summary: string, stepCount?: number): Promise<void> {
    await this.createActivity({
      type: ActivityType.PLAN_GENERATED,
      title: "Plan generated",
      summary,
      metadata: stepCount != null ? { stepCount } : undefined,
    });
  }

  async emitReviewCompleted(verdict: string, summary: string): Promise<void> {
    await this.createActivity({
      type: ActivityType.REVIEW_COMPLETED,
      title: `Review: ${verdict}`,
      summary,
      metadata: { verdict },
    });
  }

  async emitCiCheck(title: string, passed: boolean): Promise<void> {
    await this.createActivity({
      type: ActivityType.CI_CHECK,
      title,
      metadata: { passed },
    });
  }

  async emitError(message: string): Promise<void> {
    await this.createActivity({
      type: ActivityType.ERROR,
      title: "Error occurred",
      summary: message,
    });
  }

  async emitTaskSummary(summary: string): Promise<void> {
    await this.createActivity({
      type: ActivityType.TASK_SUMMARY,
      title: "Task completed",
      summary,
    });
  }

  private async createActivity(data: {
    type: ActivityType;
    title: string;
    summary?: string;
    metadata?: Record<string, unknown>;
    durationMs?: number;
  }): Promise<void> {
    await prisma.taskActivity
      .create({
        data: {
          taskId: this.taskId,
          type: data.type,
          title: data.title,
          summary: data.summary,
          metadata: data.metadata ? JSON.parse(JSON.stringify(data.metadata)) : undefined,
          durationMs: data.durationMs,
        },
      })
      .catch(() => {});
  }
}
