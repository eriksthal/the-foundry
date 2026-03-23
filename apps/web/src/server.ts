import express, { type Request, type Response } from "express";
import { z } from "zod";

import { V1_TASK_LIFECYCLE_STATES } from "@the-foundry/shared";

import type { FindingCreateInput, FindingCreateResult } from "./db.js";
import {
	type TaskClaimResult,
	TaskNotFoundError,
	TaskTransitionValidationError,
	type TaskApproveInput,
	type TaskApproveResult,
	RunNotFoundError,
	type RunCompleteInput,
	type RunCompleteResult,
	type TaskDetail,
} from "./db.js";
import type { TaskListInput, TaskListItem } from "./db.js";

interface ServerDeps {
	createFindingAndTask(input: FindingCreateInput): Promise<FindingCreateResult>;
	listTasks(input: TaskListInput): Promise<TaskListItem[]>;
	getTaskDetail?(taskId: number): Promise<TaskDetail | null>;
	approveTask(input: TaskApproveInput): Promise<TaskApproveResult>;
	claimApprovedTask(): Promise<TaskClaimResult>;
	completeRun?(input: RunCompleteInput): Promise<RunCompleteResult>;
}

interface DetailOutcome {
	status: "passed" | "failed" | "unknown";
	passed: boolean | null;
	provider: string;
	description: string;
	rationale?: string;
}

interface DetailArtifactSummary {
	artifactKey: string;
	summary: string;
}

interface TaskDetailResponse {
	id: number;
	title: string;
	state: string;
	failureReason: string | null;
	latestRun: {
		runId: number;
		status: string;
		startedAt: string;
		finishedAt: string | null;
		endedAt: string | null;
		ci: DetailOutcome;
		review: DetailOutcome;
		artifactSummaries: DetailArtifactSummary[];
	} | null;
}

const findingCreateSchema = z
	.object({
		sourceKey: z.string().trim().min(1, "sourceKey is required"),
		title: z.string().trim().min(1, "title is required"),
		detail: z.string().optional(),
	})
	.strict();

const taskListQuerySchema = z
	.object({
		state: z.enum(V1_TASK_LIFECYCLE_STATES).optional(),
	})
	.strict();

const taskIdParamsSchema = z
	.object({
		taskId: z.coerce.number().int().positive(),
	})
	.strict();

const taskApproveBodySchema = z
	.object({
		mode: z.enum(["approve", "manual_retry"]).optional(),
		reason: z.string().trim().min(1, "reason must be non-empty").optional(),
	})
	.strict();

const runIdParamsSchema = z
	.object({
		runId: z.coerce.number().int().positive(),
	})
	.strict();

const runCompleteBodySchema = z
	.object({
		ciPassed: z.boolean(),
		reviewPassed: z.boolean(),
		failureReason: z.string().trim().min(1, "failureReason must be non-empty").optional(),
		artifacts: z
			.array(
				z
					.object({
						artifactKey: z.string().trim().min(1, "artifactKey is required"),
						location: z.string().trim().min(1, "location is required"),
					})
					.strict(),
			)
			.default([]),
	})
	.strict();

function toValidationResponse(error: z.ZodError): {
	error: "validation_error";
	issues: Array<{ path: string; message: string }>;
} {
	return {
		error: "validation_error",
		issues: error.issues.map((issue) => ({
			path: issue.path.join("."),
			message: issue.message,
		})),
	};
}

function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}
	return `${value.slice(0, Math.max(0, maxChars - 14))}...<truncated>`;
}

function parseArtifactPayload(location: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(location) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function parseArtifactProvider(payload: Record<string, unknown> | null): string | null {
	if (!payload) {
		return null;
	}
	const providerCall = payload.providerCall;
	if (!providerCall || typeof providerCall !== "object" || Array.isArray(providerCall)) {
		return null;
	}
	const providerValue = (providerCall as Record<string, unknown>).provider;
	return typeof providerValue === "string" && providerValue.trim() !== ""
		? providerValue.trim()
		: null;
}

function toCiOutcome(detail: TaskDetail): DetailOutcome {
	const latestRun = detail.latestRun;
	const ciArtifact = latestRun?.artifacts.find((artifact) => artifact.artifactKey === "ci.command.log");
	const payload = ciArtifact ? parseArtifactPayload(ciArtifact.location) : null;

	if (payload) {
		const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
		const timedOut = payload.timedOut === true;
		const durationMs = typeof payload.durationMs === "number" ? payload.durationMs : null;
		const passed = exitCode === 0 && !timedOut;
		const status: DetailOutcome["status"] = passed ? "passed" : "failed";
		const durationText = durationMs === null ? "n/a" : `${durationMs}ms`;

		return {
			status,
			passed,
			provider: "local_command",
			description: `exitCode=${exitCode ?? "n/a"} timeout=${timedOut} duration=${durationText}`,
		};
	}

	if (latestRun?.status === "done") {
		return {
			status: "passed",
			passed: true,
			provider: "local_command",
			description: "passed",
		};
	}

	if (detail.failureReason?.startsWith("ci_")) {
		return {
			status: "failed",
			passed: false,
			provider: "local_command",
			description: detail.failureReason,
		};
	}

	return {
		status: "unknown",
		passed: null,
		provider: "local_command",
		description: "not available",
	};
}

function toReviewOutcome(detail: TaskDetail): DetailOutcome {
	const latestRun = detail.latestRun;
	const reviewArtifact = latestRun?.artifacts.find(
		(artifact) => artifact.artifactKey === "review.decision",
	);
	const payload = reviewArtifact ? parseArtifactPayload(reviewArtifact.location) : null;

	if (payload) {
		const passed = typeof payload.passed === "boolean" ? payload.passed : null;
		const rationale = typeof payload.rationale === "string" ? payload.rationale : undefined;
		const provider = parseArtifactProvider(payload) ?? "unknown";

		if (passed !== null) {
			return {
				status: passed ? "passed" : "failed",
				passed,
				provider,
				description: passed ? "passed" : "failed",
				rationale,
			};
		}
	}

	if (latestRun?.status === "done") {
		return {
			status: "passed",
			passed: true,
			provider: "unknown",
			description: "passed",
		};
	}

	if (detail.failureReason?.includes("review") || detail.failureReason?.startsWith("llm_")) {
		return {
			status: "failed",
			passed: false,
			provider: "unknown",
			description: detail.failureReason,
		};
	}

	return {
		status: "unknown",
		passed: null,
		provider: "unknown",
		description: "not available",
	};
}

function toArtifactSummaries(detail: TaskDetail): DetailArtifactSummary[] {
	if (!detail.latestRun || detail.latestRun.status !== "failed") {
		return [];
	}

	return detail.latestRun.artifacts.map((artifact) => {
		const payload = parseArtifactPayload(artifact.location);
		if (!payload) {
			return {
				artifactKey: artifact.artifactKey,
				summary: truncateText(artifact.location, 140),
			};
		}

		if (artifact.artifactKey === "ci.command.log") {
			const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : "n/a";
			const timedOut = payload.timedOut === true;
			const logTail = typeof payload.logTail === "string" ? truncateText(payload.logTail, 90) : "";
			return {
				artifactKey: artifact.artifactKey,
				summary: `exitCode=${exitCode} timeout=${timedOut} tail=${logTail}`,
			};
		}

		if (artifact.artifactKey === "review.decision") {
			const passed = typeof payload.passed === "boolean" ? payload.passed : "n/a";
			const rationale = typeof payload.rationale === "string" ? truncateText(payload.rationale, 90) : "n/a";
			return {
				artifactKey: artifact.artifactKey,
				summary: `passed=${passed} rationale=${rationale}`,
			};
		}

		if (artifact.artifactKey === "execute.response.summary") {
			const success = typeof payload.success === "boolean" ? payload.success : "n/a";
			const finishReason =
				typeof payload.finishReason === "string"
					? payload.finishReason
					: typeof (payload.error as { code?: unknown } | undefined)?.code === "string"
						? (payload.error as { code: string }).code
						: "n/a";
			return {
				artifactKey: artifact.artifactKey,
				summary: `success=${success} result=${finishReason}`,
			};
		}

		const payloadType = typeof payload.type === "string" ? payload.type : "structured_artifact";
		return {
			artifactKey: artifact.artifactKey,
			summary: payloadType,
		};
	});
}

function mapTaskDetail(detail: TaskDetail): TaskDetailResponse {
	if (!detail.latestRun) {
		return {
			id: detail.id,
			title: detail.title,
			state: detail.state,
			failureReason: detail.failureReason,
			latestRun: null,
		};
	}

	return {
		id: detail.id,
		title: detail.title,
		state: detail.state,
		failureReason: detail.failureReason,
		latestRun: {
			runId: detail.latestRun.runId,
			status: detail.latestRun.status,
			startedAt: detail.latestRun.startedAt,
			finishedAt: detail.latestRun.finishedAt,
			endedAt: detail.latestRun.endedAt,
			ci: toCiOutcome(detail),
			review: toReviewOutcome(detail),
			artifactSummaries: toArtifactSummaries(detail),
		},
	};
}

function renderQueuePageHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Task Queue</title>
	<style>
		:root {
			color-scheme: light;
			--bg: #f8f9fb;
			--panel: #ffffff;
			--line: #d8dce5;
			--text: #111827;
			--muted: #4b5563;
			--btn: #0f766e;
			--btn-text: #ffffff;
			--btn-alt: #1d4ed8;
			--danger: #b91c1c;
		}

		body {
			margin: 0;
			font-family: "SF Mono", "Menlo", "Monaco", "Consolas", monospace;
			background: linear-gradient(180deg, #fbfcff 0%, var(--bg) 100%);
			color: var(--text);
		}

		main {
			max-width: 980px;
			margin: 24px auto;
			padding: 0 16px;
		}

		.panel {
			background: var(--panel);
			border: 1px solid var(--line);
			border-radius: 8px;
			overflow: hidden;
		}

		h1 {
			margin: 0;
			font-size: 20px;
			font-weight: 700;
			letter-spacing: 0.01em;
		}

		.header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 8px;
			padding: 12px 14px;
			border-bottom: 1px solid var(--line);
		}

		.status {
			font-size: 12px;
			color: var(--muted);
			min-height: 16px;
		}

		.status.error {
			color: var(--danger);
		}

		table {
			width: 100%;
			border-collapse: collapse;
			font-size: 14px;
		}

		th,
		td {
			text-align: left;
			padding: 10px 12px;
			border-bottom: 1px solid var(--line);
			vertical-align: top;
		}

		th {
			font-size: 12px;
			color: var(--muted);
			text-transform: uppercase;
			letter-spacing: 0.04em;
			background: #fbfbfd;
		}

		tr:last-child td {
			border-bottom: 0;
		}

		.state {
			font-weight: 600;
			white-space: nowrap;
		}

		.summary {
			color: var(--muted);
			white-space: pre-line;
			min-width: 240px;
		}

		.actions {
			white-space: nowrap;
		}

		button {
			border: 0;
			border-radius: 6px;
			padding: 6px 10px;
			font-size: 12px;
			font-family: inherit;
			cursor: pointer;
			color: var(--btn-text);
			background: var(--btn);
		}

		button.retry {
			background: var(--btn-alt);
		}

		button:disabled {
			opacity: 0.6;
			cursor: default;
		}

		@media (max-width: 760px) {
			table,
			thead,
			tbody,
			th,
			td,
			tr {
				display: block;
			}

			thead {
				display: none;
			}

			td {
				border-bottom: 0;
				padding: 8px 12px;
			}

			tr {
				border-bottom: 1px solid var(--line);
				padding: 8px 0;
			}
		}
	</style>
</head>
<body>
	<main>
		<section class="panel" aria-label="Task queue panel">
			<div class="header">
				<h1>Task Queue</h1>
				<div id="queue-status" class="status" aria-live="polite"></div>
			</div>
			<table aria-label="Task queue table">
				<thead>
					<tr>
						<th>Title</th>
						<th>State</th>
						<th>Latest Run</th>
						<th>Action</th>
					</tr>
				</thead>
				<tbody id="queue-table-body">
					<tr><td colspan="4">Loading...</td></tr>
				</tbody>
			</table>
		</section>
	</main>
	<script>
		const tableBody = document.getElementById("queue-table-body");
		const statusNode = document.getElementById("queue-status");

		function setStatus(message, isError = false) {
			statusNode.textContent = message;
			statusNode.className = isError ? "status error" : "status";
		}

		function formatRunSummary(latestRun) {
			if (!latestRun) {
				return "No runs yet";
			}

			const started = latestRun.startedAt ? new Date(latestRun.startedAt).toISOString() : "n/a";
			const finished = latestRun.finishedAt ? new Date(latestRun.finishedAt).toISOString() : "running";
			return "status: " + latestRun.status + "\nstarted: " + started + "\nfinished: " + finished;
		}

		function createActionButton(task) {
			let mode = null;
			let label = "";
			let buttonClass = "";

			if (task.state === "awaiting_approval") {
				mode = "approve";
				label = "Approve";
			} else if (task.state === "failed") {
				mode = "manual_retry";
				label = "Retry";
				buttonClass = "retry";
			}

			if (!mode) {
				const idle = document.createElement("span");
				idle.textContent = "-";
				return idle;
			}

			const button = document.createElement("button");
			button.type = "button";
			button.textContent = label;
			if (buttonClass) {
				button.className = buttonClass;
			}

			button.addEventListener("click", async () => {
				button.disabled = true;
				setStatus("Submitting action for task #" + task.id + "...");

				const payload =
					mode === "manual_retry"
						? { mode: "manual_retry", reason: "queue_ui_manual_retry" }
						: { mode: "approve" };

		        try {
		          const response = await fetch("/api/tasks/" + task.id + "/approve", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(payload),
					});

					if (!response.ok) {
						const responseBody = await response.text();
						throw new Error("HTTP " + response.status + " " + responseBody);
					}

					setStatus("Updated task #" + task.id + ".");
					await loadTasks();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					setStatus("Action failed: " + message, true);
					button.disabled = false;
				}
			});

			return button;
		}

		function renderTasks(tasks) {
			tableBody.innerHTML = "";

			if (!Array.isArray(tasks) || tasks.length === 0) {
				const emptyRow = document.createElement("tr");
				const emptyCell = document.createElement("td");
				emptyCell.colSpan = 4;
				emptyCell.textContent = "Queue is empty.";
				emptyRow.appendChild(emptyCell);
				tableBody.appendChild(emptyRow);
				return;
			}

			for (const task of tasks) {
				const row = document.createElement("tr");

				const titleCell = document.createElement("td");
				const titleLink = document.createElement("a");
				titleLink.href = "/tasks/" + task.id;
				titleLink.textContent = String(task.title ?? "");
				titleCell.appendChild(titleLink);

				const stateCell = document.createElement("td");
				stateCell.className = "state";
				stateCell.textContent = String(task.state ?? "");

				const summaryCell = document.createElement("td");
				summaryCell.className = "summary";
				summaryCell.textContent = formatRunSummary(task.latestRun ?? null);

				const actionCell = document.createElement("td");
				actionCell.className = "actions";
				actionCell.appendChild(createActionButton(task));

				row.appendChild(titleCell);
				row.appendChild(stateCell);
				row.appendChild(summaryCell);
				row.appendChild(actionCell);
				tableBody.appendChild(row);
			}
		}

		async function loadTasks() {
			setStatus("Loading tasks...");
			try {
				const response = await fetch("/api/tasks", { cache: "no-store" });
				if (!response.ok) {
					const responseBody = await response.text();
					throw new Error("HTTP " + response.status + " " + responseBody);
				}

				const tasks = await response.json();
				renderTasks(tasks);
				setStatus("Loaded " + tasks.length + " task(s).");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				setStatus("Failed to load tasks: " + message, true);
				tableBody.innerHTML = "";
				const errorRow = document.createElement("tr");
				const errorCell = document.createElement("td");
				errorCell.colSpan = 4;
				errorCell.textContent = "Failed to load queue.";
				errorRow.appendChild(errorCell);
				tableBody.appendChild(errorRow);
			}
		}

		void loadTasks();
	</script>
</body>
</html>`;
}

function renderTaskDetailPageHtml(taskId: number): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Task Detail</title>
	<style>
		:root {
			color-scheme: light;
			--bg: #f8f9fb;
			--panel: #ffffff;
			--line: #d8dce5;
			--text: #111827;
			--muted: #4b5563;
			--btn: #0f766e;
			--btn-text: #ffffff;
			--btn-alt: #1d4ed8;
			--danger: #b91c1c;
		}

		body {
			margin: 0;
			font-family: "SF Mono", "Menlo", "Monaco", "Consolas", monospace;
			background: linear-gradient(180deg, #fbfcff 0%, var(--bg) 100%);
			color: var(--text);
		}

		main {
			max-width: 980px;
			margin: 24px auto;
			padding: 0 16px;
		}

		.panel {
			background: var(--panel);
			border: 1px solid var(--line);
			border-radius: 8px;
			padding: 14px;
		}

		h1 {
			margin: 0 0 6px;
			font-size: 20px;
		}

		a {
			color: #1d4ed8;
		}

		.grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 10px;
			margin-top: 12px;
		}

		.card {
			border: 1px solid var(--line);
			border-radius: 8px;
			padding: 10px;
		}

		.label {
			font-size: 12px;
			text-transform: uppercase;
			letter-spacing: 0.04em;
			color: var(--muted);
		}

		.value {
			font-size: 14px;
			margin-top: 4px;
			white-space: pre-wrap;
		}

		.actions {
			display: flex;
			gap: 8px;
			margin-top: 12px;
		}

		button {
			border: 0;
			border-radius: 6px;
			padding: 6px 10px;
			font-size: 12px;
			font-family: inherit;
			cursor: pointer;
			color: var(--btn-text);
			background: var(--btn);
		}

		button.retry {
			background: var(--btn-alt);
		}

		button:disabled {
			opacity: 0.6;
			cursor: default;
		}

		.status {
			font-size: 12px;
			color: var(--muted);
			min-height: 18px;
			margin-top: 8px;
		}

		.status.error {
			color: var(--danger);
		}

		ul {
			padding-left: 20px;
			margin: 8px 0 0;
		}

		@media (max-width: 760px) {
			.grid {
				grid-template-columns: 1fr;
			}
		}
	</style>
</head>
<body>
	<main>
		<section class="panel" aria-label="Task detail panel">
			<a href="/queue">Back to queue</a>
			<h1 id="task-title">Task #${taskId}</h1>
			<div id="task-meta" class="value">Loading...</div>
			<div id="actions" class="actions"></div>
			<div id="detail-status" class="status" aria-live="polite"></div>
			<div class="grid">
				<div class="card">
					<div class="label">Latest Run</div>
					<div id="latest-run" class="value">n/a</div>
				</div>
				<div class="card">
					<div class="label">CI Outcome</div>
					<div id="ci-outcome" class="value">n/a</div>
				</div>
				<div class="card">
					<div class="label">Review Outcome</div>
					<div id="review-outcome" class="value">n/a</div>
				</div>
				<div class="card">
					<div class="label">Failure Details</div>
					<div id="failure-details" class="value">n/a</div>
				</div>
			</div>
			<div class="card" style="margin-top: 10px;">
				<div class="label">Failed Run Artifact Summaries</div>
				<div id="artifact-summaries" class="value">n/a</div>
			</div>
		</section>
	</main>
	<script>
		const taskId = ${taskId};
		const titleNode = document.getElementById("task-title");
		const metaNode = document.getElementById("task-meta");
		const latestRunNode = document.getElementById("latest-run");
		const ciNode = document.getElementById("ci-outcome");
		const reviewNode = document.getElementById("review-outcome");
		const failureNode = document.getElementById("failure-details");
		const artifactsNode = document.getElementById("artifact-summaries");
		const actionsNode = document.getElementById("actions");
		const statusNode = document.getElementById("detail-status");

		function setStatus(message, isError = false) {
			statusNode.textContent = message;
			statusNode.className = isError ? "status error" : "status";
		}

		function formatIso(value) {
			return value ? new Date(value).toISOString() : "n/a";
		}

		function createActionButton(task) {
			let mode = null;
			let label = "";
			let buttonClass = "";

			if (task.state === "awaiting_approval") {
				mode = "approve";
				label = "Approve";
			} else if (task.state === "failed") {
				mode = "manual_retry";
				label = "Retry";
				buttonClass = "retry";
			}

			if (!mode) {
				return null;
			}

			const button = document.createElement("button");
			button.type = "button";
			button.textContent = label;
			if (buttonClass) {
				button.className = buttonClass;
			}

			button.addEventListener("click", async () => {
				button.disabled = true;
				setStatus("Submitting action...");
				const payload =
					mode === "manual_retry"
						? { mode: "manual_retry", reason: "detail_ui_manual_retry" }
						: { mode: "approve" };

				try {
					const response = await fetch("/api/tasks/" + task.id + "/approve", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(payload),
					});

					if (!response.ok) {
						const responseBody = await response.text();
						throw new Error("HTTP " + response.status + " " + responseBody);
					}

					setStatus("Task updated.");
					await loadTaskDetail();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					setStatus("Action failed: " + message, true);
					button.disabled = false;
				}
			});

			return button;
		}

		function renderArtifactSummaries(artifactSummaries) {
			if (!Array.isArray(artifactSummaries) || artifactSummaries.length === 0) {
				artifactsNode.textContent = "n/a";
				return;
			}

			const list = document.createElement("ul");
			for (const artifact of artifactSummaries) {
				const item = document.createElement("li");
				item.textContent = String(artifact.artifactKey) + ": " + String(artifact.summary);
				list.appendChild(item);
			}

			artifactsNode.innerHTML = "";
			artifactsNode.appendChild(list);
		}

		function renderTaskDetail(task) {
			titleNode.textContent = "Task #" + task.id + " - " + task.title;
			metaNode.textContent = "state: " + task.state;
			actionsNode.innerHTML = "";
			const actionButton = createActionButton(task);
			if (actionButton) {
				actionsNode.appendChild(actionButton);
			}

			if (!task.latestRun) {
				latestRunNode.textContent = "No runs yet";
				ciNode.textContent = "n/a";
				reviewNode.textContent = "n/a";
				failureNode.textContent = task.failureReason || "n/a";
				renderArtifactSummaries([]);
				return;
			}

			latestRunNode.textContent =
				"run #" + task.latestRun.runId +
				"\nstatus: " + task.latestRun.status +
				"\nstarted: " + formatIso(task.latestRun.startedAt) +
				"\nfinished: " + formatIso(task.latestRun.finishedAt) +
				"\nended: " + formatIso(task.latestRun.endedAt);

			ciNode.textContent =
				"status: " + task.latestRun.ci.status +
				"\nprovider: " + task.latestRun.ci.provider +
				"\ndetail: " + task.latestRun.ci.description;

			reviewNode.textContent =
				"status: " + task.latestRun.review.status +
				"\nprovider: " + task.latestRun.review.provider +
				"\ndetail: " + task.latestRun.review.description +
				(task.latestRun.review.rationale ? "\nrationale: " + task.latestRun.review.rationale : "");

			failureNode.textContent = task.failureReason || "n/a";
			renderArtifactSummaries(task.latestRun.artifactSummaries);
		}

		async function loadTaskDetail() {
			setStatus("Loading task detail...");
			try {
				const response = await fetch("/api/tasks/" + taskId, { cache: "no-store" });
				if (!response.ok) {
					const responseBody = await response.text();
					throw new Error("HTTP " + response.status + " " + responseBody);
				}

				const detail = await response.json();
				renderTaskDetail(detail);
				setStatus("Loaded task detail.");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				setStatus("Failed to load task detail: " + message, true);
				metaNode.textContent = "Failed to load task detail.";
			}
		}

		void loadTaskDetail();
	</script>
</body>
</html>`;
}

export function createApp(deps: ServerDeps): express.Express {
	const app = express();
	app.use(express.json());

	app.get("/queue", (_req: Request, res: Response) => {
		return res.status(200).type("text/html").send(renderQueuePageHtml());
	});

	app.get("/tasks/:taskId", (req: Request, res: Response) => {
		const parsedParams = taskIdParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			return res.status(400).json(toValidationResponse(parsedParams.error));
		}

		return res.status(200).type("text/html").send(renderTaskDetailPageHtml(parsedParams.data.taskId));
	});

	app.get("/api/tasks", async (req: Request, res: Response) => {
		const parsed = taskListQuerySchema.safeParse(req.query);
		if (!parsed.success) {
			return res.status(400).json(toValidationResponse(parsed.error));
		}

		try {
			const tasks = await deps.listTasks(parsed.data);
			return res.status(200).json(tasks);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(
				`[web] operation=listTasks state=${parsed.data.state ?? "all"} error=${message}`,
			);
			return res.status(500).json({ error: "internal_error" });
		}
	});

	app.get("/api/tasks/:taskId", async (req: Request, res: Response) => {
		const parsedParams = taskIdParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			return res.status(400).json(toValidationResponse(parsedParams.error));
		}

		if (!deps.getTaskDetail) {
			console.error("[web] operation=getTaskDetail error=dependency_not_configured");
			return res.status(500).json({ error: "internal_error" });
		}

		try {
			const detail = await deps.getTaskDetail(parsedParams.data.taskId);
			if (!detail) {
				return res.status(404).json({ error: "task_not_found" });
			}

			return res.status(200).json(mapTaskDetail(detail));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(
				`[web] operation=getTaskDetail taskId=${parsedParams.data.taskId} error=${message}`,
			);
			return res.status(500).json({ error: "internal_error" });
		}
	});

	app.post("/api/findings", async (req: Request, res: Response) => {
		const parsed = findingCreateSchema.safeParse(req.body);
		if (!parsed.success) {
			return res.status(400).json(toValidationResponse(parsed.error));
		}

		// v1 keeps request normalization local to this endpoint.
		const normalizedInput: FindingCreateInput = {
			sourceKey: parsed.data.sourceKey,
			title: parsed.data.title,
			detail:
				parsed.data.detail === undefined
					? null
					: parsed.data.detail.trim() === ""
						? null
						: parsed.data.detail.trim(),
		};

		try {
			const created = await deps.createFindingAndTask(normalizedInput);
			return res.status(201).json(created);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(
				`[web] operation=createFindingAndTask sourceKey=${normalizedInput.sourceKey} error=${message}`,
			);
			return res.status(500).json({ error: "internal_error" });
		}
	});

	app.post("/api/tasks/:taskId/approve", async (req: Request, res: Response) => {
		const parsedParams = taskIdParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			return res.status(400).json(toValidationResponse(parsedParams.error));
		}

		const parsedBody = taskApproveBodySchema.safeParse(req.body ?? {});
		if (!parsedBody.success) {
			return res.status(400).json(toValidationResponse(parsedBody.error));
		}

		const approveInput: TaskApproveInput = {
			taskId: parsedParams.data.taskId,
			mode: parsedBody.data.mode,
			reason: parsedBody.data.reason,
		};

		try {
			const approved = await deps.approveTask(approveInput);
			return res.status(200).json(approved);
		} catch (error) {
			if (error instanceof TaskNotFoundError) {
				return res.status(404).json({ error: "task_not_found" });
			}

			if (error instanceof TaskTransitionValidationError) {
				return res.status(409).json({
					error: "task_transition_error",
					transition: error.transitionError,
				});
			}

			const message = error instanceof Error ? error.message : String(error);
			console.error(
				`[web] operation=approveTask taskId=${approveInput.taskId} error=${message}`,
			);
			return res.status(500).json({ error: "internal_error" });
		}
	});

	app.post("/api/tasks/claim", async (_req: Request, res: Response) => {
		try {
			const claimed = await deps.claimApprovedTask();
			return res.status(200).json(claimed);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[web] operation=claimApprovedTask error=${message}`);
			return res.status(500).json({ error: "internal_error" });
		}
	});

	app.post("/api/runs/:runId/complete", async (req: Request, res: Response) => {
		const parsedParams = runIdParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			return res.status(400).json(toValidationResponse(parsedParams.error));
		}

		const parsedBody = runCompleteBodySchema.safeParse(req.body ?? {});
		if (!parsedBody.success) {
			return res.status(400).json(toValidationResponse(parsedBody.error));
		}

		if (!deps.completeRun) {
			console.error("[web] operation=completeRun error=dependency_not_configured");
			return res.status(500).json({ error: "internal_error" });
		}

		const completeInput: RunCompleteInput = {
			runId: parsedParams.data.runId,
			ciPassed: parsedBody.data.ciPassed,
			reviewPassed: parsedBody.data.reviewPassed,
			failureReason: parsedBody.data.failureReason,
			artifacts: parsedBody.data.artifacts,
		};

		try {
			const completed = await deps.completeRun(completeInput);
			return res.status(200).json(completed);
		} catch (error) {
			if (error instanceof RunNotFoundError) {
				return res.status(404).json({ error: "run_not_found" });
			}

			if (error instanceof TaskTransitionValidationError) {
				return res.status(409).json({
					error: "task_transition_error",
					transition: error.transitionError,
				});
			}

			const message = error instanceof Error ? error.message : String(error);
			console.error(
				`[web] operation=completeRun runId=${completeInput.runId} error=${message}`,
			);
			return res.status(500).json({ error: "internal_error" });
		}
	});

	return app;
}
