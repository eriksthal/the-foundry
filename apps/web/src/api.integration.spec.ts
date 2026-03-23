import { deepStrictEqual, strictEqual } from "node:assert";
import { after, before, beforeEach, test } from "node:test";

import { type Pool } from "pg";
import request from "supertest";

import { createApp } from "./server.js";
import {
	approveTask,
	claimApprovedTask,
	completeRun,
	createFindingAndTask,
	getTaskDetail,
	listTasks,
} from "./db.js";
import {
	applyMigrations,
	createIntegrationPool,
	resetIntegrationTables,
	resolveIntegrationDatabaseUrl,
} from "./integration-test-db.js";

interface TaskStateRow {
	state: string;
	failure_reason: string | null;
}

interface ArtifactRow {
	artifact_key: string;
	location: string;
}

function asNumericIdText(value: unknown): string {
	const valueType = typeof value;
	strictEqual(valueType === "string" || valueType === "number", true);
	const idText = String(value);
	strictEqual(/^\d+$/.test(idText), true);
	return idText;
}

function asNumericId(value: unknown): number {
	return Number.parseInt(asNumericIdText(value), 10);
}

const integrationDatabaseUrl = resolveIntegrationDatabaseUrl();
const isCi = process.env.CI === "true";

if (!integrationDatabaseUrl) {
	if (isCi) {
		test("integration suite fails in CI when TEST_DATABASE_URL and DATABASE_URL are unset", () => {
			throw new Error(
				"CI=true requires integration database configuration via TEST_DATABASE_URL or DATABASE_URL",
			);
		});
	} else {
		test("integration suite skipped: set TEST_DATABASE_URL or DATABASE_URL", { skip: true }, () => {
			strictEqual(1, 1);
		});
	}
} else {
	let pool: Pool;
	const app = createApp({
		createFindingAndTask: (input) => createFindingAndTask(pool, input),
		listTasks: (input) => listTasks(pool, input),
		getTaskDetail: (taskId) => getTaskDetail(pool, taskId),
		approveTask: (input) => approveTask(pool, input),
		claimApprovedTask: () => claimApprovedTask(pool),
		completeRun: (input) => completeRun(pool, input),
	});

	before(async () => {
		pool = createIntegrationPool(integrationDatabaseUrl);
		const client = await pool.connect();
		try {
			await applyMigrations(client);
		} finally {
			client.release();
		}
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

	test("POST /api/findings ingests finding and creates awaiting_approval task in one flow", async () => {
		const createResponse = await request(app).post("/api/findings").send({
			sourceKey: "integration.ingest.1",
			title: "Integration finding",
			detail: "integration detail",
		});

		strictEqual(createResponse.status, 201);
		strictEqual(createResponse.body.taskState, "awaiting_approval");
		const findingId = asNumericIdText(createResponse.body.findingId);
		const taskId = asNumericIdText(createResponse.body.taskId);
		strictEqual(findingId.length > 0, true);
		strictEqual(taskId.length > 0, true);

		const listResponse = await request(app).get("/api/tasks");
		strictEqual(listResponse.status, 200);
		strictEqual(listResponse.body.length, 1);
		strictEqual(asNumericIdText(listResponse.body[0].id), taskId);
		strictEqual(listResponse.body[0].state, "awaiting_approval");
		strictEqual(listResponse.body[0].title, "Integration finding");
	});

	test("invalid transition is rejected by API", async () => {
		const createResponse = await request(app).post("/api/findings").send({
			sourceKey: "integration.transition.1",
			title: "Transition finding",
			detail: "transition detail",
		});

		strictEqual(createResponse.status, 201);
		const taskId = asNumericIdText(createResponse.body.taskId);

		const approveResponse = await request(app)
			.post(`/api/tasks/${taskId}/approve`)
			.send({ mode: "approve" });
		strictEqual(approveResponse.status, 200);

		const claimResponse = await request(app).post("/api/tasks/claim").send({});
		strictEqual(claimResponse.status, 200);
		strictEqual(asNumericIdText(claimResponse.body.taskId), taskId);

		const invalidApproveResponse = await request(app)
			.post(`/api/tasks/${taskId}/approve`)
			.send({ mode: "approve" });

		strictEqual(invalidApproveResponse.status, 409);
		strictEqual(invalidApproveResponse.body.error, "task_transition_error");
		strictEqual(invalidApproveResponse.body.transition.code, "INVALID_TASK_TRANSITION");
		strictEqual(invalidApproveResponse.body.transition.from, "in_progress");
		strictEqual(invalidApproveResponse.body.transition.to, "approved");
	});

	test("concurrent claims allow only one claimer to lock and claim one task", async () => {
		const createResponse = await request(app).post("/api/findings").send({
			sourceKey: "integration.claim.1",
			title: "Claim finding",
			detail: "claim detail",
		});

		strictEqual(createResponse.status, 201);
		const taskId = asNumericIdText(createResponse.body.taskId);

		const approveResponse = await request(app)
			.post(`/api/tasks/${taskId}/approve`)
			.send({ mode: "approve" });
		strictEqual(approveResponse.status, 200);

		const [claimA, claimB] = await Promise.all([
			request(app).post("/api/tasks/claim").send({}),
			request(app).post("/api/tasks/claim").send({}),
		]);

		strictEqual(claimA.status, 200);
		strictEqual(claimB.status, 200);

		const claims = [claimA.body, claimB.body];
		const successfulClaims = claims.filter((claim) => claim.taskId !== null);
		const emptyClaims = claims.filter((claim) => claim.taskId === null);

		strictEqual(successfulClaims.length, 1);
		strictEqual(emptyClaims.length, 1);
		strictEqual(asNumericIdText(successfulClaims[0].taskId), taskId);
		const claimedRunId = asNumericIdText(successfulClaims[0].runId);
		strictEqual(claimedRunId.length > 0, true);
		deepStrictEqual(emptyClaims[0], { taskId: null, runId: null });
	});

	test("manual retry can re-approve a failed task and complete a second run", async () => {
		const createResponse = await request(app).post("/api/findings").send({
			sourceKey: "integration.retry.1",
			title: "Retry finding",
			detail: "retry detail",
		});

		strictEqual(createResponse.status, 201);
		const taskId = asNumericIdText(createResponse.body.taskId);

		const approveResponse = await request(app)
			.post(`/api/tasks/${taskId}/approve`)
			.send({ mode: "approve" });
		strictEqual(approveResponse.status, 200);

		const firstClaimResponse = await request(app).post("/api/tasks/claim").send({});
		strictEqual(firstClaimResponse.status, 200);
		strictEqual(asNumericIdText(firstClaimResponse.body.taskId), taskId);
		const firstRunId = asNumericId(firstClaimResponse.body.runId);

		const firstCompleteResponse = await request(app)
			.post(`/api/runs/${firstRunId}/complete`)
			.send({
				ciPassed: false,
				reviewPassed: true,
				artifacts: [],
			});
		strictEqual(firstCompleteResponse.status, 200);
		strictEqual(firstCompleteResponse.body.taskState, "failed");
		strictEqual(firstCompleteResponse.body.failureReason, "ci_failed");

		const retryApproveResponse = await request(app)
			.post(`/api/tasks/${taskId}/approve`)
			.send({ mode: "manual_retry" });
		strictEqual(retryApproveResponse.status, 200);
		strictEqual(retryApproveResponse.body.previousState, "failed");
		strictEqual(retryApproveResponse.body.taskState, "approved");

		const secondClaimResponse = await request(app).post("/api/tasks/claim").send({});
		strictEqual(secondClaimResponse.status, 200);
		strictEqual(asNumericIdText(secondClaimResponse.body.taskId), taskId);
		const secondRunId = asNumericId(secondClaimResponse.body.runId);
		strictEqual(Number.isInteger(secondRunId), true);
		strictEqual(secondRunId > firstRunId, true);

		const secondCompleteResponse = await request(app)
			.post(`/api/runs/${secondRunId}/complete`)
			.send({
				ciPassed: true,
				reviewPassed: true,
				artifacts: [],
			});
		strictEqual(secondCompleteResponse.status, 200);
		strictEqual(secondCompleteResponse.body.taskState, "done");
		strictEqual(secondCompleteResponse.body.failureReason, null);

		const doneTasksResponse = await request(app).get("/api/tasks").query({ state: "done" });
		strictEqual(doneTasksResponse.status, 200);
		strictEqual(doneTasksResponse.body.length, 1);
		strictEqual(asNumericIdText(doneTasksResponse.body[0].id), taskId);
		strictEqual(doneTasksResponse.body[0].state, "done");
	});

	test("run completion defaults failureReason when both CI and review fail", async () => {
		const createResponse = await request(app).post("/api/findings").send({
			sourceKey: "integration.complete.1",
			title: "Completion finding",
			detail: "completion detail",
		});

		strictEqual(createResponse.status, 201);
		const taskId = asNumericIdText(createResponse.body.taskId);

		const approveResponse = await request(app)
			.post(`/api/tasks/${taskId}/approve`)
			.send({ mode: "approve" });
		strictEqual(approveResponse.status, 200);

		const claimResponse = await request(app).post("/api/tasks/claim").send({});
		strictEqual(claimResponse.status, 200);
		strictEqual(asNumericIdText(claimResponse.body.taskId), taskId);
		const runId = asNumericId(claimResponse.body.runId);

		const completeResponse = await request(app)
			.post(`/api/runs/${runId}/complete`)
			.send({
				ciPassed: false,
				reviewPassed: false,
				artifacts: [],
			});

		strictEqual(completeResponse.status, 200);
		strictEqual(asNumericId(completeResponse.body.runId), runId);
		strictEqual(asNumericIdText(completeResponse.body.taskId), taskId);
		strictEqual(completeResponse.body.runStatus, "failed");
		strictEqual(completeResponse.body.taskState, "failed");
		strictEqual(completeResponse.body.failureReason, "ci_and_review_failed");
	});

	test("E2E lifecycle success path reaches done and persists artifacts", async () => {
		const createResponse = await request(app).post("/api/findings").send({
			sourceKey: "integration.e2e.success.1",
			title: "E2E success finding",
			detail: "e2e success detail",
		});

		strictEqual(createResponse.status, 201);
		const taskId = asNumericIdText(createResponse.body.taskId);

		const approveResponse = await request(app)
			.post(`/api/tasks/${taskId}/approve`)
			.send({ mode: "approve" });
		strictEqual(approveResponse.status, 200);

		const claimResponse = await request(app).post("/api/tasks/claim").send({});
		strictEqual(claimResponse.status, 200);
		strictEqual(asNumericIdText(claimResponse.body.taskId), taskId);
		const runId = asNumericId(claimResponse.body.runId);

		const artifacts = [
			{ artifactKey: "ci.log", location: "s3://artifacts/e2e/success/ci.log" },
			{ artifactKey: "review.md", location: "s3://artifacts/e2e/success/review.md" },
		];

		const completeResponse = await request(app)
			.post(`/api/runs/${runId}/complete`)
			.send({
				ciPassed: true,
				reviewPassed: true,
				artifacts,
			});

		strictEqual(completeResponse.status, 200);
		strictEqual(completeResponse.body.taskState, "done");
		strictEqual(completeResponse.body.failureReason, null);

		const taskStateResult = await pool.query<TaskStateRow>(
			"SELECT state, failure_reason FROM tasks WHERE id = $1",
			[asNumericId(taskId)],
		);
		strictEqual(taskStateResult.rows.length, 1);
		strictEqual(taskStateResult.rows[0].state, "done");
		strictEqual(taskStateResult.rows[0].failure_reason, null);

		const artifactResult = await pool.query<ArtifactRow>(
			`SELECT artifact_key, location
			 FROM artifacts
			 WHERE run_id = $1
			 ORDER BY id ASC`,
			[runId],
		);
		strictEqual(artifactResult.rows.length, 2);
		deepStrictEqual(artifactResult.rows, [
			{ artifact_key: "ci.log", location: "s3://artifacts/e2e/success/ci.log" },
			{ artifact_key: "review.md", location: "s3://artifacts/e2e/success/review.md" },
		]);
	});

	test("E2E lifecycle failure path reaches failed, stores reason, and persists artifacts", async () => {
		const createResponse = await request(app).post("/api/findings").send({
			sourceKey: "integration.e2e.failure.1",
			title: "E2E failure finding",
			detail: "e2e failure detail",
		});

		strictEqual(createResponse.status, 201);
		const taskId = asNumericIdText(createResponse.body.taskId);

		const approveResponse = await request(app)
			.post(`/api/tasks/${taskId}/approve`)
			.send({ mode: "approve" });
		strictEqual(approveResponse.status, 200);

		const claimResponse = await request(app).post("/api/tasks/claim").send({});
		strictEqual(claimResponse.status, 200);
		strictEqual(asNumericIdText(claimResponse.body.taskId), taskId);
		const runId = asNumericId(claimResponse.body.runId);

		const completeResponse = await request(app)
			.post(`/api/runs/${runId}/complete`)
			.send({
				ciPassed: false,
				reviewPassed: true,
				failureReason: "deterministic_ci_failure",
				artifacts: [
					{ artifactKey: "ci.log", location: "s3://artifacts/e2e/failure/ci.log" },
				],
			});

		strictEqual(completeResponse.status, 200);
		strictEqual(completeResponse.body.taskState, "failed");
		strictEqual(completeResponse.body.failureReason, "deterministic_ci_failure");

		const taskStateResult = await pool.query<TaskStateRow>(
			"SELECT state, failure_reason FROM tasks WHERE id = $1",
			[asNumericId(taskId)],
		);
		strictEqual(taskStateResult.rows.length, 1);
		strictEqual(taskStateResult.rows[0].state, "failed");
		strictEqual(taskStateResult.rows[0].failure_reason, "deterministic_ci_failure");

		const artifactResult = await pool.query<ArtifactRow>(
			`SELECT artifact_key, location
			 FROM artifacts
			 WHERE run_id = $1
			 ORDER BY id ASC`,
			[runId],
		);
		strictEqual(artifactResult.rows.length, 1);
		deepStrictEqual(artifactResult.rows, [
			{ artifact_key: "ci.log", location: "s3://artifacts/e2e/failure/ci.log" },
		]);
	});

	test("GET /api/tasks/:taskId returns latest run timeline, outcomes, and compact failed artifact summaries", async () => {
		const createResponse = await request(app).post("/api/findings").send({
			sourceKey: "integration.detail.1",
			title: "Detail finding",
			detail: "detail view",
		});

		strictEqual(createResponse.status, 201);
		const taskId = asNumericIdText(createResponse.body.taskId);

		const approveResponse = await request(app)
			.post(`/api/tasks/${taskId}/approve`)
			.send({ mode: "approve" });
		strictEqual(approveResponse.status, 200);

		const claimResponse = await request(app).post("/api/tasks/claim").send({});
		strictEqual(claimResponse.status, 200);
		const runId = asNumericId(claimResponse.body.runId);

		const completeResponse = await request(app)
			.post(`/api/runs/${runId}/complete`)
			.send({
				ciPassed: false,
				reviewPassed: false,
				failureReason: "ci_failed",
				artifacts: [
					{
						artifactKey: "ci.command.log",
						location:
							'{"type":"ci.command.log.v1","exitCode":2,"timedOut":false,"durationMs":1600,"logTail":"typecheck failed"}',
					},
					{
						artifactKey: "review.decision",
						location:
							'{"type":"review.decision.v1","passed":false,"rationale":"blocked by CI","providerCall":{"provider":"copilot"}}',
					},
				],
			});
		strictEqual(completeResponse.status, 200);

		const detailResponse = await request(app).get(`/api/tasks/${taskId}`);
		strictEqual(detailResponse.status, 200);
		strictEqual(asNumericIdText(detailResponse.body.id), taskId);
		strictEqual(detailResponse.body.latestRun.status, "failed");
		strictEqual(detailResponse.body.latestRun.ci.provider, "local_command");
		strictEqual(detailResponse.body.latestRun.review.provider, "copilot");
		strictEqual(detailResponse.body.latestRun.artifactSummaries.length, 2);
		strictEqual(detailResponse.body.failureReason, "ci_failed");
	});
}