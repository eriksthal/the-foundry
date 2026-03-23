import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import test from "node:test";

import {
	approveTask,
	claimApprovedTask,
	completeRun,
	createFindingAndTask,
	getTaskDetail,
	listTasks,
	type QueryResultLike,
	type SqlClient,
	type SqlPool,
	TaskTransitionValidationError,
	withTransaction,
} from "./db.js";

interface TaskListRowFixture {
	task_id: number;
	title: string;
	task_state: "awaiting_approval" | "approved" | "in_progress" | "done" | "failed";
	run_status: string | null;
	run_started_at: string | null;
	run_finished_at: string | null;
}

interface TaskClaimRowFixture {
	task_id: number;
	run_id: number;
	task_state: "awaiting_approval" | "approved" | "in_progress" | "done" | "failed";
}

interface RunTaskRowFixture {
	run_id: number;
	task_id: number;
	task_state: "awaiting_approval" | "approved" | "in_progress" | "done" | "failed";
}

interface TaskDetailRowFixture {
	task_id: number;
	title: string;
	task_state: "awaiting_approval" | "approved" | "in_progress" | "done" | "failed";
	task_failure_reason: string | null;
	run_id: number | null;
	run_status: string | null;
	run_started_at: string | null;
	run_finished_at: string | null;
	run_ended_at: string | null;
}

interface ArtifactRowFixture {
	artifact_key: string;
	location: string;
}

class FakeClient implements SqlClient {
	public readonly commands: string[] = [];
	public readonly commandParams: Array<readonly unknown[] | undefined> = [];
	public released = false;
	private findingId = 10;
	private readonly failOnTaskInsert: boolean;
	private readonly taskRows: TaskListRowFixture[];
	private readonly taskStateForApprove: TaskListRowFixture["task_state"] | null;
	private readonly taskClaimRow: TaskClaimRowFixture | null;
	private readonly runTaskForCompletion: RunTaskRowFixture | null;
	private readonly taskDetailRow: TaskDetailRowFixture | null;
	private readonly artifactRows: ArtifactRowFixture[];

	public constructor(options?: {
		failOnTaskInsert?: boolean;
		taskRows?: TaskListRowFixture[];
		taskStateForApprove?: TaskListRowFixture["task_state"] | null;
		taskClaimRow?: TaskClaimRowFixture | null;
		runTaskForCompletion?: RunTaskRowFixture | null;
		taskDetailRow?: TaskDetailRowFixture | null;
		artifactRows?: ArtifactRowFixture[];
	}) {
		this.failOnTaskInsert = options?.failOnTaskInsert ?? false;
		this.taskRows = options?.taskRows ?? [];
		this.taskStateForApprove = options?.taskStateForApprove ?? "awaiting_approval";
		this.taskClaimRow = options?.taskClaimRow ?? null;
		this.runTaskForCompletion = options?.runTaskForCompletion ?? null;
		this.taskDetailRow = options?.taskDetailRow ?? null;
		this.artifactRows = options?.artifactRows ?? [];
	}

	public async query<T = Record<string, unknown>>(
		queryText: string,
		queryParams?: readonly unknown[],
	): Promise<QueryResultLike<T>> {
		this.commands.push(queryText);
		this.commandParams.push(queryParams);

		if (queryText.startsWith("INSERT INTO findings")) {
			const nextId = this.findingId;
			this.findingId += 1;
			return { rows: [{ id: nextId } as T] };
		}

		if (queryText.startsWith("INSERT INTO tasks")) {
			if (this.failOnTaskInsert) {
				throw new Error("task_insert_failure");
			}
			return {
				rows: [{ id: 200, state: queryParams?.[1] } as T],
			};
		}

		if (
			queryText.startsWith("SELECT t.id AS task_id") &&
			queryText.includes("t.failure_reason AS task_failure_reason")
		) {
			if (!this.taskDetailRow) {
				return { rows: [] };
			}
			return { rows: [this.taskDetailRow as T] };
		}

		if (queryText.startsWith("SELECT t.id AS task_id")) {
			return { rows: this.taskRows as T[] };
		}

		if (queryText.startsWith("SELECT a.artifact_key")) {
			return { rows: this.artifactRows as T[] };
		}

		if (queryText.startsWith("SELECT state")) {
			if (this.taskStateForApprove === null) {
				return { rows: [] };
			}

			return {
				rows: [{ state: this.taskStateForApprove } as T],
			};
		}

		if (queryText.startsWith("UPDATE tasks")) {
			return {
				rows: [{ id: queryParams?.[0], state: queryParams?.[1] } as T],
			};
		}

		if (queryText.startsWith("WITH candidate AS")) {
			if (!this.taskClaimRow) {
				return { rows: [] };
			}

			return {
				rows: [this.taskClaimRow as T],
			};
		}

		if (queryText.startsWith("SELECT r.id AS run_id")) {
			if (!this.runTaskForCompletion) {
				return { rows: [] };
			}

			return {
				rows: [this.runTaskForCompletion as T],
			};
		}

		if (queryText.startsWith("UPDATE runs")) {
			return {
				rows: [
					{
						id: queryParams?.[0],
						task_id: this.runTaskForCompletion?.task_id,
						status: queryParams?.[1],
					} as T,
				],
			};
		}

		if (queryText.startsWith("INSERT INTO artifacts")) {
			return { rows: [] };
		}

		return { rows: [] };
	}

	public release(): void {
		this.released = true;
	}
}

class FakePool implements SqlPool {
	private readonly client: FakeClient;

	public constructor(client: FakeClient) {
		this.client = client;
	}

	public async connect(): Promise<SqlClient> {
		return this.client;
	}
}

test("createFindingAndTask persists task in awaiting_approval and commits", async () => {
	const client = new FakeClient();
	const pool = new FakePool(client);

	const result = await createFindingAndTask(pool, {
		sourceKey: "s1",
		title: "title",
		detail: null,
	});

	deepStrictEqual(result, {
		findingId: 10,
		taskId: 200,
		taskState: "awaiting_approval",
	});
	strictEqual(client.commands[0], "BEGIN");
	strictEqual(client.commands[3], "COMMIT");
	strictEqual(client.released, true);
});

test("withTransaction rolls back on failure", async () => {
	const client = new FakeClient();
	const pool = new FakePool(client);

	await rejects(
		withTransaction(pool, async () => {
			throw new Error("forced_failure");
		}),
		/forced_failure/,
	);

	strictEqual(client.commands[0], "BEGIN");
	strictEqual(client.commands[1], "ROLLBACK");
	strictEqual(client.released, true);
});

test("createFindingAndTask triggers rollback when task insert fails", async () => {
	const client = new FakeClient({ failOnTaskInsert: true });
	const pool = new FakePool(client);

	await rejects(
		createFindingAndTask(pool, {
			sourceKey: "s2",
			title: "title",
			detail: "details",
		}),
		/task_insert_failure/,
	);

	strictEqual(client.commands[0], "BEGIN");
	strictEqual(client.commands[3], "ROLLBACK");
	strictEqual(client.released, true);
});

test("listTasks selects latest run summary and maps compact payload", async () => {
	const client = new FakeClient({
		taskRows: [
			{
				task_id: 7,
				title: "Review finding",
				task_state: "approved",
				run_status: "done",
				run_started_at: "2026-03-22T09:00:00.000Z",
				run_finished_at: "2026-03-22T09:01:00.000Z",
			},
			{
				task_id: 8,
				title: "Ship patch",
				task_state: "awaiting_approval",
				run_status: null,
				run_started_at: null,
				run_finished_at: null,
			},
		],
	});
	const pool = new FakePool(client);

	const result = await listTasks(pool, {});

	deepStrictEqual(result, [
		{
			id: 7,
			title: "Review finding",
			state: "approved",
			latestRun: {
				status: "done",
				startedAt: "2026-03-22T09:00:00.000Z",
				finishedAt: "2026-03-22T09:01:00.000Z",
			},
		},
		{
			id: 8,
			title: "Ship patch",
			state: "awaiting_approval",
			latestRun: null,
		},
	]);

	strictEqual(client.released, true);
	strictEqual(client.commandParams[0]?.[0], null);
	strictEqual(client.commands[0].includes("LEFT JOIN LATERAL"), true);
	strictEqual(client.commands[0].includes("ORDER BY t.created_at ASC, t.id ASC"), true);
});

test("listTasks applies state filter when provided", async () => {
	const client = new FakeClient();
	const pool = new FakePool(client);

	await listTasks(pool, { state: "in_progress" });

	strictEqual(client.commandParams[0]?.[0], "in_progress");
});

test("getTaskDetail returns task with latest run and compact artifacts", async () => {
	const client = new FakeClient({
		taskDetailRow: {
			task_id: 42,
			title: "Detail mapping",
			task_state: "failed",
			task_failure_reason: "ci_failed",
			run_id: 901,
			run_status: "failed",
			run_started_at: "2026-03-22T12:00:00.000Z",
			run_finished_at: "2026-03-22T12:01:00.000Z",
			run_ended_at: "2026-03-22T12:01:00.000Z",
		},
		artifactRows: [
			{ artifact_key: "ci.command.log", location: "{\"type\":\"ci.command.log.v1\"}" },
			{ artifact_key: "review.decision", location: "{\"type\":\"review.decision.v1\"}" },
		],
	});
	const pool = new FakePool(client);

	const result = await getTaskDetail(pool, 42);

	deepStrictEqual(result, {
		id: 42,
		title: "Detail mapping",
		state: "failed",
		failureReason: "ci_failed",
		latestRun: {
			runId: 901,
			status: "failed",
			startedAt: "2026-03-22T12:00:00.000Z",
			finishedAt: "2026-03-22T12:01:00.000Z",
			endedAt: "2026-03-22T12:01:00.000Z",
			artifacts: [
				{ artifactKey: "ci.command.log", location: "{\"type\":\"ci.command.log.v1\"}" },
				{ artifactKey: "review.decision", location: "{\"type\":\"review.decision.v1\"}" },
			],
		},
	});

	strictEqual(client.released, true);
	strictEqual(client.commandParams[0]?.[0], 42);
	strictEqual(client.commandParams[1]?.[0], 901);
});

test("getTaskDetail returns null when task is not found", async () => {
	const client = new FakeClient({ taskDetailRow: null });
	const pool = new FakePool(client);

	const result = await getTaskDetail(pool, 999);

	strictEqual(result, null);
	strictEqual(client.released, true);
});

test("approveTask transitions awaiting_approval -> approved transactionally", async () => {
	const client = new FakeClient({ taskStateForApprove: "awaiting_approval" });
	const pool = new FakePool(client);

	const result = await approveTask(pool, {
		taskId: 33,
		mode: "approve",
	});

	deepStrictEqual(result, {
		taskId: 33,
		previousState: "awaiting_approval",
		taskState: "approved",
	});
	strictEqual(client.commands[0], "BEGIN");
	strictEqual(client.commands[3], "COMMIT");
	strictEqual(client.released, true);
});

test("approveTask transitions failed -> approved only with manual retry", async () => {
	const client = new FakeClient({ taskStateForApprove: "failed" });
	const pool = new FakePool(client);

	const result = await approveTask(pool, {
		taskId: 44,
		mode: "manual_retry",
		reason: "operator approved retry",
	});

	deepStrictEqual(result, {
		taskId: 44,
		previousState: "failed",
		taskState: "approved",
	});
	strictEqual(client.commands[0], "BEGIN");
	strictEqual(client.commands[3], "COMMIT");
	strictEqual(client.released, true);
});

test("approveTask rejects invalid source state with deterministic transition error", async () => {
	const client = new FakeClient({ taskStateForApprove: "done" });
	const pool = new FakePool(client);

	await rejects(
		approveTask(pool, {
			taskId: 55,
			mode: "approve",
		}),
		(error: unknown) => {
			strictEqual(error instanceof TaskTransitionValidationError, true);
			if (error instanceof TaskTransitionValidationError) {
				deepStrictEqual(error.transitionError, {
					code: "INVALID_TASK_TRANSITION",
					message: "transition_not_allowed",
					from: "done",
					to: "approved",
				});
			}
			return true;
		},
	);

	strictEqual(client.commands[0], "BEGIN");
	strictEqual(client.commands[2], "ROLLBACK");
	strictEqual(client.released, true);
});

test("claimApprovedTask atomically claims one approved task and creates one running run", async () => {
	const client = new FakeClient({
		taskClaimRow: {
			task_id: 91,
			run_id: 501,
			task_state: "in_progress",
		},
	});
	const pool = new FakePool(client);

	const result = await claimApprovedTask(pool);

	deepStrictEqual(result, {
		taskId: 91,
		runId: 501,
	});
	strictEqual(client.commands[0], "BEGIN");
	strictEqual(client.commands[2], "COMMIT");
	strictEqual(client.released, true);
	strictEqual(client.commands[1].includes("FOR UPDATE SKIP LOCKED"), true);
	strictEqual(client.commands[1].includes("LIMIT 1"), true);
	strictEqual(client.commands[1].includes("SET state = 'in_progress'"), true);
	strictEqual(client.commands[1].includes("INSERT INTO runs (task_id, status)"), true);
});

test("claimApprovedTask returns empty claim result when no approved task exists", async () => {
	const client = new FakeClient({ taskClaimRow: null });
	const pool = new FakePool(client);

	const result = await claimApprovedTask(pool);

	deepStrictEqual(result, {
		taskId: null,
		runId: null,
	});
	strictEqual(client.commands[0], "BEGIN");
	strictEqual(client.commands[2], "COMMIT");
	strictEqual(client.released, true);
});

test("completeRun finalizes run and task to done when CI and review pass", async () => {
	const client = new FakeClient({
		runTaskForCompletion: {
			run_id: 7001,
			task_id: 300,
			task_state: "in_progress",
		},
	});
	const pool = new FakePool(client);

	const result = await completeRun(pool, {
		runId: 7001,
		ciPassed: true,
		reviewPassed: true,
		artifacts: [
			{ artifactKey: "ci.log", location: "s3://bucket/runs/7001/ci.log" },
			{ artifactKey: "review.md", location: "s3://bucket/runs/7001/review.md" },
		],
	});

	deepStrictEqual(result, {
		runId: 7001,
		taskId: 300,
		runStatus: "done",
		taskState: "done",
		failureReason: null,
	});
	strictEqual(client.commands[0], "BEGIN");
	strictEqual(client.commands[6], "COMMIT");
	strictEqual(client.released, true);
	strictEqual(client.commands[1].includes("FOR UPDATE OF r, t"), true);
	strictEqual(client.commands[2].includes("SET status = $2"), true);
	strictEqual(client.commands[2].includes("finished_at = NOW()"), true);
	strictEqual(client.commands[3].includes("INSERT INTO artifacts"), true);
	strictEqual(client.commands[4].includes("INSERT INTO artifacts"), true);
	strictEqual(client.commands[5].includes("failure_reason = $3"), true);
	strictEqual(client.commandParams[5]?.[2], null);
});

test("completeRun marks task failed and stores derived failure_reason on failure path", async () => {
	const client = new FakeClient({
		runTaskForCompletion: {
			run_id: 7002,
			task_id: 301,
			task_state: "in_progress",
		},
	});
	const pool = new FakePool(client);

	const result = await completeRun(pool, {
		runId: 7002,
		ciPassed: false,
		reviewPassed: true,
		artifacts: [],
	});

	deepStrictEqual(result, {
		runId: 7002,
		taskId: 301,
		runStatus: "failed",
		taskState: "failed",
		failureReason: "ci_failed",
	});
	strictEqual(client.commands[0], "BEGIN");
	strictEqual(client.commands[4], "COMMIT");
	strictEqual(client.released, true);
	strictEqual(client.commandParams[3]?.[2], "ci_failed");
});
