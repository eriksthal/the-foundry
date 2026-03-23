import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import request from "supertest";

import type { FindingCreateInput } from "./db.js";
import { TaskTransitionValidationError } from "./db.js";
import { createApp } from "./server.js";

test("GET /api/tasks returns compact queue payload with latest run summary", async () => {
	const app = createApp({
		createFindingAndTask: async () => ({
			findingId: 1,
			taskId: 2,
			taskState: "awaiting_approval",
		}),
		listTasks: async () => [
			{
				id: 11,
				title: "Upgrade dependency",
				state: "in_progress",
				latestRun: {
					status: "running",
					startedAt: "2026-03-22T10:00:00.000Z",
					finishedAt: null,
				},
			},
			{
				id: 12,
				title: "Rotate key",
				state: "awaiting_approval",
				latestRun: null,
			},
		],
			approveTask: async () => ({
				taskId: 2,
				previousState: "awaiting_approval",
				taskState: "approved",
			}),
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
	});

	const response = await request(app).get("/api/tasks");

	strictEqual(response.status, 200);
	deepStrictEqual(response.body, [
		{
			id: 11,
			title: "Upgrade dependency",
			state: "in_progress",
			latestRun: {
				status: "running",
				startedAt: "2026-03-22T10:00:00.000Z",
				finishedAt: null,
			},
		},
		{
			id: 12,
			title: "Rotate key",
			state: "awaiting_approval",
			latestRun: null,
		},
	]);
});

test("GET /api/tasks forwards optional state filter", async () => {
	const captured: string[] = [];
	const app = createApp({
		createFindingAndTask: async () => ({
			findingId: 1,
			taskId: 2,
			taskState: "awaiting_approval",
		}),
		listTasks: async (input) => {
			captured.push(input.state ?? "all");
			return [];
		},
		approveTask: async () => ({
			taskId: 2,
			previousState: "awaiting_approval",
			taskState: "approved",
		}),
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
	});

	const response = await request(app).get("/api/tasks").query({ state: "approved" });

	strictEqual(response.status, 200);
	deepStrictEqual(response.body, []);
	deepStrictEqual(captured, ["approved"]);
});

test("GET /api/tasks rejects invalid state filter with no read attempt", async () => {
	let readCount = 0;
	const app = createApp({
		createFindingAndTask: async () => ({
			findingId: 1,
			taskId: 2,
			taskState: "awaiting_approval",
		}),
		listTasks: async () => {
			readCount += 1;
			return [];
		},
		approveTask: async () => ({
			taskId: 2,
			previousState: "awaiting_approval",
			taskState: "approved",
		}),
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
	});

	const response = await request(app).get("/api/tasks").query({ state: "invalid_state" });

	strictEqual(response.status, 400);
	strictEqual(response.body.error, "validation_error");
	strictEqual(readCount, 0);
});

test("GET /api/tasks/:taskId returns mapped detail outcomes and compact failed artifact summaries", async () => {
	const app = createApp({
		createFindingAndTask: async () => ({
			findingId: 1,
			taskId: 2,
			taskState: "awaiting_approval",
		}),
		listTasks: async () => [],
		getTaskDetail: async () => ({
			id: 11,
			title: "Detail task",
			state: "failed",
			failureReason: "ci_failed",
			latestRun: {
				runId: 910,
				status: "failed",
				startedAt: "2026-03-22T10:00:00.000Z",
				finishedAt: "2026-03-22T10:01:00.000Z",
				endedAt: "2026-03-22T10:01:00.000Z",
				artifacts: [
					{
						artifactKey: "ci.command.log",
						location:
							'{"type":"ci.command.log.v1","exitCode":2,"timedOut":false,"durationMs":4200,"logTail":"lint failed"}',
					},
					{
						artifactKey: "review.decision",
						location:
							'{"type":"review.decision.v1","passed":false,"rationale":"blocked","providerCall":{"provider":"copilot"}}',
					},
				],
			},
		}),
		approveTask: async () => ({
			taskId: 2,
			previousState: "awaiting_approval",
			taskState: "approved",
		}),
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
	});

	const response = await request(app).get("/api/tasks/11");

	strictEqual(response.status, 200);
	strictEqual(response.body.latestRun.ci.provider, "local_command");
	strictEqual(response.body.latestRun.review.provider, "copilot");
	strictEqual(response.body.latestRun.review.status, "failed");
	strictEqual(response.body.latestRun.artifactSummaries.length, 2);
	strictEqual(response.body.latestRun.artifactSummaries[0].artifactKey, "ci.command.log");
});

test("GET /api/tasks/:taskId returns 404 for unknown task", async () => {
	const app = createApp({
		createFindingAndTask: async () => ({
			findingId: 1,
			taskId: 2,
			taskState: "awaiting_approval",
		}),
		listTasks: async () => [],
		getTaskDetail: async () => null,
		approveTask: async () => ({
			taskId: 2,
			previousState: "awaiting_approval",
			taskState: "approved",
		}),
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
	});

	const response = await request(app).get("/api/tasks/999");

	strictEqual(response.status, 404);
	deepStrictEqual(response.body, { error: "task_not_found" });
});

test("GET /queue returns minimal queue UI HTML", async () => {
	const app = createApp({
		createFindingAndTask: async () => ({
			findingId: 1,
			taskId: 2,
			taskState: "awaiting_approval",
		}),
		listTasks: async () => [],
		approveTask: async () => ({
			taskId: 2,
			previousState: "awaiting_approval",
			taskState: "approved",
		}),
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
	});

	const response = await request(app).get("/queue");

	strictEqual(response.status, 200);
	strictEqual(response.type, "text/html");
	strictEqual(response.text.includes("<h1>Task Queue</h1>"), true);
	strictEqual(response.text.includes('id="queue-table-body"'), true);
	strictEqual(response.text.includes('fetch("/api/tasks"'), true);
	strictEqual(response.text.includes('"/api/tasks/" + task.id + "/approve"'), true);
	strictEqual(response.text.includes('titleLink.href = "/tasks/" + task.id'), true);
});

test("GET /tasks/:taskId returns minimal detail UI HTML", async () => {
	const app = createApp({
		createFindingAndTask: async () => ({
			findingId: 1,
			taskId: 2,
			taskState: "awaiting_approval",
		}),
		listTasks: async () => [],
		approveTask: async () => ({
			taskId: 2,
			previousState: "awaiting_approval",
			taskState: "approved",
		}),
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
	});

	const response = await request(app).get("/tasks/12");

	strictEqual(response.status, 200);
	strictEqual(response.type, "text/html");
	strictEqual(response.text.includes("Task #12"), true);
	strictEqual(response.text.includes('fetch("/api/tasks/" + taskId'), true);
	strictEqual(response.text.includes('"/api/tasks/" + task.id + "/approve"'), true);
});

test("GET /queue includes approve and manual_retry action wiring", async () => {
	const app = createApp({
		createFindingAndTask: async () => ({
			findingId: 1,
			taskId: 2,
			taskState: "awaiting_approval",
		}),
		listTasks: async () => [],
		approveTask: async () => ({
			taskId: 2,
			previousState: "awaiting_approval",
			taskState: "approved",
		}),
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
	});

	const response = await request(app).get("/queue");

	strictEqual(response.status, 200);
	strictEqual(response.text.includes('task.state === "awaiting_approval"'), true);
	strictEqual(response.text.includes('task.state === "failed"'), true);
	strictEqual(response.text.includes('{ mode: "approve" }'), true);
	strictEqual(
		response.text.includes('{ mode: "manual_retry", reason: "queue_ui_manual_retry" }'),
		true,
	);
});

test("POST /api/findings inserts one finding and returns created ids", async () => {
	const captured: FindingCreateInput[] = [];
	const app = createApp({
		createFindingAndTask: async (input) => {
			captured.push(input);
			return {
				findingId: 101,
				taskId: 202,
				taskState: "awaiting_approval",
			};
		},
		listTasks: async () => [],
		approveTask: async () => ({
			taskId: 202,
			previousState: "awaiting_approval",
			taskState: "approved",
		}),
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
	});

	const response = await request(app).post("/api/findings").send({
		sourceKey: " scanner.rule-7 ",
		title: " Outdated package detected ",
		detail: "   ",
	});

	strictEqual(response.status, 201);
	deepStrictEqual(response.body, {
		findingId: 101,
		taskId: 202,
		taskState: "awaiting_approval",
	});
	deepStrictEqual(captured, [
		{
			sourceKey: "scanner.rule-7",
			title: "Outdated package detected",
			detail: null,
		},
	]);
});

test("POST /api/findings rejects invalid payload with no write attempt", async () => {
	let callCount = 0;
	const app = createApp({
		createFindingAndTask: async () => {
			callCount += 1;
			return {
				findingId: 1,
				taskId: 2,
				taskState: "awaiting_approval",
			};
		},
		listTasks: async () => [],
		approveTask: async () => ({
			taskId: 2,
			previousState: "awaiting_approval",
			taskState: "approved",
		}),
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
	});

	const response = await request(app).post("/api/findings").send({
		sourceKey: "",
		title: "valid-title",
		extra: "unexpected",
	});

	strictEqual(response.status, 400);
	strictEqual(response.body.error, "validation_error");
	strictEqual(callCount, 0);
});

test("POST /api/tasks/:taskId/approve approves awaiting_approval tasks", async () => {
	const app = createApp({
		createFindingAndTask: async () => ({
			findingId: 1,
			taskId: 2,
			taskState: "awaiting_approval",
		}),
		listTasks: async () => [],
		approveTask: async () => ({
			taskId: 55,
			previousState: "awaiting_approval",
			taskState: "approved",
		}),
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
	});

	const response = await request(app).post("/api/tasks/55/approve").send({ mode: "approve" });

	strictEqual(response.status, 200);
	deepStrictEqual(response.body, {
		taskId: 55,
		previousState: "awaiting_approval",
		taskState: "approved",
	});
});

test("POST /api/tasks/:taskId/approve supports manual retry for failed tasks", async () => {
	const app = createApp({
		createFindingAndTask: async () => ({
			findingId: 1,
			taskId: 2,
			taskState: "awaiting_approval",
		}),
		listTasks: async () => [],
		approveTask: async () => ({
			taskId: 77,
			previousState: "failed",
			taskState: "approved",
		}),
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
	});

	const response = await request(app)
		.post("/api/tasks/77/approve")
		.send({ mode: "manual_retry", reason: "operator approved retry" });

	strictEqual(response.status, 200);
	deepStrictEqual(response.body, {
		taskId: 77,
		previousState: "failed",
		taskState: "approved",
	});
});

test("POST /api/tasks/:taskId/approve returns deterministic transition errors", async () => {
	const app = createApp({
		createFindingAndTask: async () => ({
			findingId: 1,
			taskId: 2,
			taskState: "awaiting_approval",
		}),
		listTasks: async () => [],
		approveTask: async () => {
			throw new TaskTransitionValidationError({
				code: "INVALID_TASK_TRANSITION",
				message: "transition_not_allowed",
				from: "done",
				to: "approved",
			});
		},
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
	});

	const response = await request(app).post("/api/tasks/90/approve").send({ mode: "approve" });

	strictEqual(response.status, 409);
	deepStrictEqual(response.body, {
		error: "task_transition_error",
		transition: {
			code: "INVALID_TASK_TRANSITION",
			message: "transition_not_allowed",
			from: "done",
			to: "approved",
		},
	});
});

test("POST /api/tasks/claim returns one compact claim when an approved task is available", async () => {
	const app = createApp({
		createFindingAndTask: async () => ({
			findingId: 1,
			taskId: 2,
			taskState: "awaiting_approval",
		}),
		listTasks: async () => [],
		approveTask: async () => ({
			taskId: 2,
			previousState: "awaiting_approval",
			taskState: "approved",
		}),
		claimApprovedTask: async () => ({
			taskId: 88,
			runId: 3001,
		}),
	});

	const response = await request(app).post("/api/tasks/claim").send({});

	strictEqual(response.status, 200);
	deepStrictEqual(response.body, {
		taskId: 88,
		runId: 3001,
	});
});

test("POST /api/tasks/claim returns empty compact claim when queue has no approved task", async () => {
	const app = createApp({
		createFindingAndTask: async () => ({
			findingId: 1,
			taskId: 2,
			taskState: "awaiting_approval",
		}),
		listTasks: async () => [],
		approveTask: async () => ({
			taskId: 2,
			previousState: "awaiting_approval",
			taskState: "approved",
		}),
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
	});

	const response = await request(app).post("/api/tasks/claim").send({});

	strictEqual(response.status, 200);
	deepStrictEqual(response.body, {
		taskId: null,
		runId: null,
	});
});

test("POST /api/runs/:runId/complete marks run and task done when CI and review pass", async () => {
	const app = createApp({
		createFindingAndTask: async () => ({
			findingId: 1,
			taskId: 2,
			taskState: "awaiting_approval",
		}),
		listTasks: async () => [],
		approveTask: async () => ({
			taskId: 2,
			previousState: "awaiting_approval",
			taskState: "approved",
		}),
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
		completeRun: async () => ({
			runId: 3001,
			taskId: 88,
			runStatus: "done",
			taskState: "done",
			failureReason: null,
		}),
	});

	const response = await request(app).post("/api/runs/3001/complete").send({
		ciPassed: true,
		reviewPassed: true,
		artifacts: [
			{
				artifactKey: "ci.log",
				location: "s3://bucket/runs/3001/ci.log",
			},
		],
	});

	strictEqual(response.status, 200);
	deepStrictEqual(response.body, {
		runId: 3001,
		taskId: 88,
		runStatus: "done",
		taskState: "done",
		failureReason: null,
	});
});

test("POST /api/runs/:runId/complete marks failed path with failure reason", async () => {
	const app = createApp({
		createFindingAndTask: async () => ({
			findingId: 1,
			taskId: 2,
			taskState: "awaiting_approval",
		}),
		listTasks: async () => [],
		approveTask: async () => ({
			taskId: 2,
			previousState: "awaiting_approval",
			taskState: "approved",
		}),
		claimApprovedTask: async () => ({
			taskId: null,
			runId: null,
		}),
		completeRun: async () => ({
			runId: 3002,
			taskId: 89,
			runStatus: "failed",
			taskState: "failed",
			failureReason: "ci_failed",
		}),
	});

	const response = await request(app).post("/api/runs/3002/complete").send({
		ciPassed: false,
		reviewPassed: true,
		artifacts: [
			{
				artifactKey: "review.txt",
				location: "s3://bucket/runs/3002/review.txt",
			},
		],
	});

	strictEqual(response.status, 200);
	deepStrictEqual(response.body, {
		runId: 3002,
		taskId: 89,
		runStatus: "failed",
		taskState: "failed",
		failureReason: "ci_failed",
	});
});
