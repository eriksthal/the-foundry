import { deepStrictEqual, strictEqual } from "node:assert";
import { after, before, beforeEach, test } from "node:test";

import type { Express } from "express";
import type { Pool } from "pg";
import request from "supertest";

import { createApp } from "../../web/src/server.js";
import {
  approveTask,
  claimApprovedTask,
  completeRun,
  createFindingAndTask,
  listTasks,
} from "../../web/src/db.js";
import {
  applyMigrations,
  createIntegrationPool,
  resetIntegrationTables,
  resolveIntegrationDatabaseUrl,
} from "../../web/src/integration-test-db.js";
import type { WorkerApiClient } from "../src/api-client.js";
import { createPollingWorker } from "../src/polling-worker.js";

interface TaskStateRow {
  state: string;
  failure_reason: string | null;
}

interface RunStatusRow {
  run_id: number;
  status: "running" | "done" | "failed";
}

interface ArtifactRow {
  artifact_key: string;
  location: string;
}

function createInProcessApiClient(app: Express): WorkerApiClient {
  return {
    async claimTask() {
      const response = await request(app).post("/api/tasks/claim").send({});
      if (response.status !== 200) {
        throw new Error(`claim_failed_status_${response.status}`);
      }
      return {
        taskId: response.body.taskId as number | null,
        runId: response.body.runId as number | null,
      };
    },
    async completeRun(input) {
      const response = await request(app)
        .post(`/api/runs/${input.runId}/complete`)
        .send({
          ciPassed: input.ciPassed,
          reviewPassed: input.reviewPassed,
          failureReason: input.failureReason,
          artifacts: input.artifacts ?? [],
        });
      if (response.status !== 200) {
        throw new Error(`complete_failed_status_${response.status}`);
      }
    },
  };
}

const integrationDatabaseUrl = resolveIntegrationDatabaseUrl();
const isCi = process.env.CI === "true";

if (!integrationDatabaseUrl) {
  if (isCi) {
    test("worker orchestration integration fails in CI when DB env is unset", () => {
      throw new Error(
        "CI=true requires TEST_DATABASE_URL or DATABASE_URL for worker orchestration integration tests",
      );
    });
  } else {
    test(
      "worker orchestration integration skipped: set TEST_DATABASE_URL or DATABASE_URL",
      { skip: true },
      () => {
        strictEqual(1, 1);
      },
    );
  }
} else {
  let pool: Pool;
  let app: Express;

  before(async () => {
    pool = createIntegrationPool(integrationDatabaseUrl);

    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }

    app = createApp({
      createFindingAndTask: (input) => createFindingAndTask(pool, input),
      listTasks: (input) => listTasks(pool, input),
      approveTask: (input) => approveTask(pool, input),
      claimApprovedTask: () => claimApprovedTask(pool),
      completeRun: (input) => completeRun(pool, input),
    });
  });

  beforeEach(async () => {
    const client = await pool.connect();
    try {
      await resetIntegrationTables(client);
    } finally {
      client.release();
    }
  });

  after(async () => {
    await pool.end();
  });

  async function createApprovedTask(sourceKey: string): Promise<{ taskId: number }> {
    const createResponse = await request(app).post("/api/findings").send({
      sourceKey,
      title: `Title for ${sourceKey}`,
      detail: "deterministic integration test detail",
    });
    strictEqual(createResponse.status, 201);

    const taskId = createResponse.body.taskId as number;
    const approveResponse = await request(app)
      .post(`/api/tasks/${taskId}/approve`)
      .send({ mode: "approve" });
    strictEqual(approveResponse.status, 200);

    return { taskId };
  }

  async function loadRunStatus(taskId: number): Promise<RunStatusRow> {
    const result = await pool.query<RunStatusRow>(
      `SELECT id AS run_id, status
       FROM runs
       WHERE task_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [taskId],
    );

    strictEqual(result.rows.length, 1);
    return result.rows[0] as RunStatusRow;
  }

  async function loadArtifacts(runId: number): Promise<ArtifactRow[]> {
    const result = await pool.query<ArtifactRow>(
      `SELECT artifact_key, location
       FROM artifacts
       WHERE run_id = $1
       ORDER BY artifact_key ASC`,
      [runId],
    );

    return result.rows;
  }

  test("worker orchestration success path transitions to done and persists step artifacts", async () => {
    const { taskId } = await createApprovedTask("integration.worker.success.1");

    const stepOrder: string[] = [];
    const worker = createPollingWorker({
      apiClient: createInProcessApiClient(app),
      pollIntervalMs: 1,
      runTimeoutMs: 200,
      sleep: async () => undefined,
      steps: {
        async execute() {
          stepOrder.push("execute");
          return {
            ok: true,
            artifacts: [
              {
                artifactKey: "execute.response.summary",
                data: {
                  type: "execute.response.summary.v1",
                  success: true,
                  finishReason: "stop",
                  outputPreview: "deterministic execute success",
                },
              },
            ],
          };
        },
        async ci() {
          stepOrder.push("ci");
          return {
            ok: true,
            artifacts: [
              {
                artifactKey: "ci.command.log",
                data: {
                  type: "ci.command.log.v1",
                  exitCode: 0,
                  timedOut: false,
                  signal: null,
                  durationMs: 1,
                  logTail: "all green",
                },
              },
            ],
          };
        },
        async review() {
          stepOrder.push("review");
          return {
            ok: true,
            passed: true,
            rationale: "approved by deterministic stub",
            artifacts: [
              {
                artifactKey: "review.decision",
                data: {
                  type: "review.decision.v1",
                  passed: true,
                  rationale: "approved by deterministic stub",
                },
              },
            ],
          };
        },
      },
    });

    const processed = await worker.tick();
    strictEqual(processed, true);
    deepStrictEqual(stepOrder, ["execute", "ci", "review"]);

    const taskResult = await pool.query<TaskStateRow>(
      "SELECT state, failure_reason FROM tasks WHERE id = $1",
      [taskId],
    );
    strictEqual(taskResult.rows.length, 1);
    strictEqual(taskResult.rows[0]?.state, "done");
    strictEqual(taskResult.rows[0]?.failure_reason, null);

    const run = await loadRunStatus(taskId);
    strictEqual(run.status, "done");

    const artifacts = await loadArtifacts(run.run_id);
    deepStrictEqual(
      artifacts.map((artifact) => artifact.artifact_key),
      ["ci.command.log", "execute.response.summary", "review.decision"],
    );

    for (const artifact of artifacts) {
      const parsed = JSON.parse(artifact.location) as { type?: string };
      strictEqual(typeof parsed.type, "string");
    }
  });

  test("worker orchestration failure path transitions to failed with reason and persists artifacts", async () => {
    const { taskId } = await createApprovedTask("integration.worker.failure.1");

    let reviewCalls = 0;
    const worker = createPollingWorker({
      apiClient: createInProcessApiClient(app),
      pollIntervalMs: 1,
      runTimeoutMs: 200,
      sleep: async () => undefined,
      steps: {
        async execute() {
          return {
            ok: true,
            artifacts: [
              {
                artifactKey: "execute.response.summary",
                data: {
                  type: "execute.response.summary.v1",
                  success: true,
                  outputPreview: "execute complete",
                },
              },
            ],
          };
        },
        async ci() {
          return {
            ok: false,
            failureReason: "ci_failed_deterministic",
            artifacts: [
              {
                artifactKey: "ci.command.log",
                data: {
                  type: "ci.command.log.v1",
                  exitCode: 1,
                  timedOut: false,
                  signal: null,
                  durationMs: 2,
                  logTail: "lint failed",
                },
              },
            ],
          };
        },
        async review() {
          reviewCalls += 1;
          return {
            ok: true,
            passed: true,
            rationale: "should_not_run",
          };
        },
      },
    });

    const processed = await worker.tick();
    strictEqual(processed, true);
    strictEqual(reviewCalls, 0);

    const taskResult = await pool.query<TaskStateRow>(
      "SELECT state, failure_reason FROM tasks WHERE id = $1",
      [taskId],
    );
    strictEqual(taskResult.rows.length, 1);
    strictEqual(taskResult.rows[0]?.state, "failed");
    strictEqual(taskResult.rows[0]?.failure_reason, "ci_failed_deterministic");

    const run = await loadRunStatus(taskId);
    strictEqual(run.status, "failed");

    const artifacts = await loadArtifacts(run.run_id);
    deepStrictEqual(
      artifacts.map((artifact) => artifact.artifact_key),
      ["ci.command.log", "execute.response.summary", "review.decision"],
    );

    const reviewArtifact = artifacts.find((artifact) => artifact.artifact_key === "review.decision");
    strictEqual(Boolean(reviewArtifact), true);
    const reviewPayload = JSON.parse(reviewArtifact?.location ?? "{}") as {
      source?: string;
      rationale?: string;
    };
    strictEqual(reviewPayload.source, "worker_guardrail");
    strictEqual(reviewPayload.rationale, "review_not_run_ci_failed");
  });
}
