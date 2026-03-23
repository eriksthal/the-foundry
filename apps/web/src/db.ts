import { Pool } from "pg";

import {
	transitionTaskLifecycle,
	type TaskLifecycleState,
	type TaskLifecycleTransitionError,
} from "@the-foundry/shared";

export interface FindingCreateInput {
	sourceKey: string;
	title: string;
	detail: string | null;
}

export interface FindingCreateResult {
	findingId: number;
	taskId: number;
	taskState: TaskLifecycleState;
}

export interface TaskListInput {
	state?: TaskLifecycleState;
}

export type TaskApproveMode = "approve" | "manual_retry";

export interface TaskApproveInput {
	taskId: number;
	mode?: TaskApproveMode;
	reason?: string;
}

export interface TaskApproveResult {
	taskId: number;
	previousState: TaskLifecycleState;
	taskState: TaskLifecycleState;
}

export interface TaskClaimResult {
	taskId: number | null;
	runId: number | null;
}

export interface RunCompleteArtifactInput {
	artifactKey: string;
	location: string;
}

export interface RunCompleteInput {
	runId: number;
	ciPassed: boolean;
	reviewPassed: boolean;
	failureReason?: string;
	artifacts: RunCompleteArtifactInput[];
}

export interface RunCompleteResult {
	runId: number;
	taskId: number;
	runStatus: "done" | "failed";
	taskState: TaskLifecycleState;
	failureReason: string | null;
}

export interface TaskRunSummary {
	status: string;
	startedAt: string;
	finishedAt: string | null;
}

export interface TaskListItem {
	id: number;
	title: string;
	state: TaskLifecycleState;
	latestRun: TaskRunSummary | null;
}

export interface TaskRunArtifact {
	artifactKey: string;
	location: string;
}

export interface TaskLatestRunDetail {
	runId: number;
	status: string;
	startedAt: string;
	finishedAt: string | null;
	endedAt: string | null;
	artifacts: TaskRunArtifact[];
}

export interface TaskDetail {
	id: number;
	title: string;
	state: TaskLifecycleState;
	failureReason: string | null;
	latestRun: TaskLatestRunDetail | null;
}

export interface QueryResultLike<T> {
	rows: T[];
}

export interface SqlClient {
	query<T = Record<string, unknown>>(
		queryText: string,
		queryParams?: readonly unknown[],
	): Promise<QueryResultLike<T>>;
	release(): void;
}

export interface SqlPool {
	connect(): Promise<SqlClient>;
}

interface FindingIdRow {
	id: number;
}

interface TaskRow {
	id: number;
	state: TaskLifecycleState;
}

interface TaskStateRow {
	state: TaskLifecycleState;
}

interface TaskClaimRow {
	task_id: number;
	run_id: number;
	task_state: TaskLifecycleState;
}

interface RunTaskRow {
	run_id: number;
	task_id: number;
	task_state: TaskLifecycleState;
}

interface TaskListRow {
	task_id: number;
	title: string;
	task_state: TaskLifecycleState;
	run_status: string | null;
	run_started_at: string | null;
	run_finished_at: string | null;
}

interface TaskDetailRow {
	task_id: number;
	title: string;
	task_state: TaskLifecycleState;
	task_failure_reason: string | null;
	run_id: number | null;
	run_status: string | null;
	run_started_at: string | null;
	run_finished_at: string | null;
	run_ended_at: string | null;
}

interface ArtifactRow {
	artifact_key: string;
	location: string;
}

const AWAITING_APPROVAL: TaskLifecycleState = "awaiting_approval";

export class TaskNotFoundError extends Error {
	public readonly taskId: number;

	public constructor(taskId: number) {
		super("task_not_found");
		this.name = "TaskNotFoundError";
		this.taskId = taskId;
	}
}

export class TaskTransitionValidationError extends Error {
	public readonly transitionError: TaskLifecycleTransitionError;

	public constructor(transitionError: TaskLifecycleTransitionError) {
		super(transitionError.message);
		this.name = "TaskTransitionValidationError";
		this.transitionError = transitionError;
	}
}

export class RunNotFoundError extends Error {
	public readonly runId: number;

	public constructor(runId: number) {
		super("run_not_found");
		this.name = "RunNotFoundError";
		this.runId = runId;
	}
}

function buildFailureReason(input: RunCompleteInput): string | null {
	if (input.ciPassed && input.reviewPassed) {
		return null;
	}

	if (input.failureReason && input.failureReason.trim() !== "") {
		return input.failureReason.trim();
	}

	if (!input.ciPassed && !input.reviewPassed) {
		return "ci_and_review_failed";
	}

	if (!input.ciPassed) {
		return "ci_failed";
	}

	return "review_failed";
}

/**
 * Creates a PostgreSQL pool from environment configuration.
 *
 * @throws {Error} When DATABASE_URL is not set.
 */
export function createPoolFromEnv(): Pool {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required");
	}
	return new Pool({ connectionString: databaseUrl });
}

/**
 * Runs a unit of work in a SQL transaction, with rollback on any failure.
 *
 * @throws {Error} Re-throws operation failures after rollback is attempted.
 */
export async function withTransaction<T>(
	pool: SqlPool,
	operation: (client: SqlClient) => Promise<T>,
): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await operation(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		try {
			await client.query("ROLLBACK");
		} catch (rollbackError) {
			const rollbackMessage =
				rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
			console.error(
				`[web] operation=withTransaction action=rollback error=${rollbackMessage}`,
			);
		}
		throw error;
	} finally {
		client.release();
	}
}

/**
 * Persists one finding and one initial task in awaiting_approval within one transaction.
 *
 * @throws {Error} When any SQL operation fails.
 */
export async function createFindingAndTask(
	pool: SqlPool,
	input: FindingCreateInput,
): Promise<FindingCreateResult> {
	return withTransaction(pool, async (client) => {
		const findingResult = await client.query<FindingIdRow>(
			`INSERT INTO findings (source_key, title, detail)
			 VALUES ($1, $2, $3)
			 RETURNING id`,
			[input.sourceKey, input.title, input.detail],
		);

		const finding = findingResult.rows[0];
		if (!finding) {
			throw new Error("finding_insert_failed");
		}

		const taskResult = await client.query<TaskRow>(
			`INSERT INTO tasks (finding_id, state)
			 VALUES ($1, $2)
			 RETURNING id, state`,
			[finding.id, AWAITING_APPROVAL],
		);

		const task = taskResult.rows[0];
		if (!task) {
			throw new Error("task_insert_failed");
		}

		return {
			findingId: finding.id,
			taskId: task.id,
			taskState: task.state,
		};
	});
}

/**
 * Lists tasks for the UI queue view with optional state filtering.
 *
 * @throws {Error} When the SQL query fails.
 */
export async function listTasks(
	pool: SqlPool,
	input: TaskListInput,
): Promise<TaskListItem[]> {
	const stateFilter = input.state ?? null;
	const client = await pool.connect();
	try {
		const result = await client.query<TaskListRow>(
			`SELECT t.id AS task_id,
			        f.title,
			        t.state AS task_state,
			        lr.status AS run_status,
			        lr.started_at AS run_started_at,
			        lr.finished_at AS run_finished_at
			 FROM tasks t
			 INNER JOIN findings f ON f.id = t.finding_id
			 LEFT JOIN LATERAL (
			   SELECT r.status,
			          r.started_at,
			          r.finished_at
			   FROM runs r
			   WHERE r.task_id = t.id
			   ORDER BY r.started_at DESC, r.id DESC
			   LIMIT 1
			 ) lr ON TRUE
			 WHERE ($1::text IS NULL OR t.state = $1)
			 ORDER BY t.created_at ASC, t.id ASC`,
			[stateFilter],
		);

		return result.rows.map((row) => ({
			id: row.task_id,
			title: row.title,
			state: row.task_state,
			latestRun:
				row.run_status === null || row.run_started_at === null
					? null
					: {
						status: row.run_status,
						startedAt: row.run_started_at,
						finishedAt: row.run_finished_at,
					},
		}));
	} finally {
		client.release();
	}
}

/**
 * Returns one task detail with latest run timeline and compact artifact rows.
 *
 * @throws {Error} When SQL operations fail.
 */
export async function getTaskDetail(pool: SqlPool, taskId: number): Promise<TaskDetail | null> {
	const client = await pool.connect();
	try {
		const taskResult = await client.query<TaskDetailRow>(
			`SELECT t.id AS task_id,
			        f.title,
			        t.state AS task_state,
			        t.failure_reason AS task_failure_reason,
			        lr.id AS run_id,
			        lr.status AS run_status,
			        lr.started_at AS run_started_at,
			        lr.finished_at AS run_finished_at,
			        lr.ended_at AS run_ended_at
			 FROM tasks t
			 INNER JOIN findings f ON f.id = t.finding_id
			 LEFT JOIN LATERAL (
			   SELECT r.id,
			          r.status,
			          r.started_at,
			          r.finished_at,
			          r.ended_at
			   FROM runs r
			   WHERE r.task_id = t.id
			   ORDER BY r.started_at DESC, r.id DESC
			   LIMIT 1
			 ) lr ON TRUE
			 WHERE t.id = $1`,
			[taskId],
		);

		const task = taskResult.rows[0];
		if (!task) {
			return null;
		}

		if (task.run_id === null || task.run_started_at === null || task.run_status === null) {
			return {
				id: task.task_id,
				title: task.title,
				state: task.task_state,
				failureReason: task.task_failure_reason,
				latestRun: null,
			};
		}

		const artifactsResult = await client.query<ArtifactRow>(
			`SELECT a.artifact_key,
			        a.location
			 FROM artifacts a
			 WHERE a.run_id = $1
			 ORDER BY a.created_at ASC, a.id ASC
			 LIMIT 10`,
			[task.run_id],
		);

		return {
			id: task.task_id,
			title: task.title,
			state: task.task_state,
			failureReason: task.task_failure_reason,
			latestRun: {
				runId: task.run_id,
				status: task.run_status,
				startedAt: task.run_started_at,
				finishedAt: task.run_finished_at,
				endedAt: task.run_ended_at,
				artifacts: artifactsResult.rows.map((artifact) => ({
					artifactKey: artifact.artifact_key,
					location: artifact.location,
				})),
			},
		};
	} finally {
		client.release();
	}
}

/**
 * Approves a task from awaiting_approval or retries a failed task via manual approval.
 *
 * @throws {TaskNotFoundError} When the task id does not exist.
 * @throws {TaskTransitionValidationError} When lifecycle transition validation fails.
 * @throws {Error} When SQL operations fail.
 */
export async function approveTask(
	pool: SqlPool,
	input: TaskApproveInput,
): Promise<TaskApproveResult> {
	return withTransaction(pool, async (client) => {
		const currentResult = await client.query<TaskStateRow>(
			`SELECT state
			 FROM tasks
			 WHERE id = $1
			 FOR UPDATE`,
			[input.taskId],
		);

		const current = currentResult.rows[0];
		if (!current) {
			throw new TaskNotFoundError(input.taskId);
		}

		const transitionResult = transitionTaskLifecycle({
			from: current.state,
			to: "approved",
			manualRetry: input.mode === "manual_retry",
		});

		if (!transitionResult.ok) {
			throw new TaskTransitionValidationError(transitionResult.error);
		}

		const updatedResult = await client.query<TaskRow>(
			`UPDATE tasks
			 SET state = $2,
			     updated_at = NOW()
			 WHERE id = $1
			 RETURNING id, state`,
			[input.taskId, transitionResult.to],
		);

		const updated = updatedResult.rows[0];
		if (!updated) {
			throw new Error("task_update_failed");
		}

		return {
			taskId: updated.id,
			previousState: current.state,
			taskState: updated.state,
		};
	});
}

/**
 * Claims one approved task, transitions it to in_progress, and creates one running run row.
 *
 * Uses row-level locking with SKIP LOCKED so concurrent claimers cannot claim the same task.
 *
 * @throws {Error} When SQL operations fail.
 */
export async function claimApprovedTask(pool: SqlPool): Promise<TaskClaimResult> {
	return withTransaction(pool, async (client) => {
		const result = await client.query<TaskClaimRow>(
			`WITH candidate AS (
			   SELECT t.id
			   FROM tasks t
			   WHERE t.state = 'approved'
			   ORDER BY t.created_at ASC, t.id ASC
			   FOR UPDATE SKIP LOCKED
			   LIMIT 1
			 ),
			 updated AS (
			   UPDATE tasks t
			   SET state = 'in_progress',
			       updated_at = NOW()
			   FROM candidate c
			   WHERE t.id = c.id
			   RETURNING t.id, t.state
			 ),
			 inserted_run AS (
			   INSERT INTO runs (task_id, status)
			   SELECT u.id, 'running'
			   FROM updated u
			   RETURNING id, task_id
			 )
			 SELECT u.id AS task_id,
			        r.id AS run_id,
			        u.state AS task_state
			 FROM updated u
			 INNER JOIN inserted_run r ON r.task_id = u.id`,
		);

		const claimed = result.rows[0];
		if (!claimed) {
			return {
				taskId: null,
				runId: null,
			};
		}

		return {
			taskId: claimed.task_id,
			runId: claimed.run_id,
		};
	});
}

/**
 * Completes one run, persists artifacts, and transitions its task to done or failed.
 *
 * @throws {RunNotFoundError} When the run id does not exist.
 * @throws {TaskTransitionValidationError} When lifecycle transition validation fails.
 * @throws {Error} When SQL operations fail.
 */
export async function completeRun(
	pool: SqlPool,
	input: RunCompleteInput,
): Promise<RunCompleteResult> {
	return withTransaction(pool, async (client) => {
		const runTaskResult = await client.query<RunTaskRow>(
			`SELECT r.id AS run_id,
			        r.task_id AS task_id,
			        t.state AS task_state
			 FROM runs r
			 INNER JOIN tasks t ON t.id = r.task_id
			 WHERE r.id = $1
			 FOR UPDATE OF r, t`,
			[input.runId],
		);

		const runTask = runTaskResult.rows[0];
		if (!runTask) {
			throw new RunNotFoundError(input.runId);
		}

		const targetTaskState: TaskLifecycleState =
			input.ciPassed && input.reviewPassed ? "done" : "failed";
		const transitionResult = transitionTaskLifecycle({
			from: runTask.task_state,
			to: targetTaskState,
		});

		if (!transitionResult.ok) {
			throw new TaskTransitionValidationError(transitionResult.error);
		}

		const targetRunStatus: "done" | "failed" =
			targetTaskState === "done" ? "done" : "failed";
		const finalFailureReason = buildFailureReason(input);

		const updatedRunResult = await client.query<{ id: number; task_id: number; status: "done" | "failed" }>(
			`UPDATE runs
			 SET status = $2,
			     finished_at = NOW(),
			     ended_at = NOW()
			 WHERE id = $1
			 RETURNING id, task_id, status`,
			[input.runId, targetRunStatus],
		);

		const updatedRun = updatedRunResult.rows[0];
		if (!updatedRun) {
			throw new Error("run_update_failed");
		}

		for (const artifact of input.artifacts) {
			await client.query(
				`INSERT INTO artifacts (run_id, artifact_key, location)
				 VALUES ($1, $2, $3)`,
				[input.runId, artifact.artifactKey, artifact.location],
			);
		}

		const updatedTaskResult = await client.query<TaskRow>(
			`UPDATE tasks
			 SET state = $2,
			     failure_reason = $3,
			     updated_at = NOW()
			 WHERE id = $1
			 RETURNING id, state`,
			[runTask.task_id, transitionResult.to, finalFailureReason],
		);

		const updatedTask = updatedTaskResult.rows[0];
		if (!updatedTask) {
			throw new Error("task_update_failed");
		}

		return {
			runId: updatedRun.id,
			taskId: updatedTask.id,
			runStatus: updatedRun.status,
			taskState: updatedTask.state,
			failureReason: finalFailureReason,
		};
	});
}
