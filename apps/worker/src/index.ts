import { packageId } from "@the-foundry/shared";

import { createHttpWorkerApiClient } from "./api-client.js";
import {
	createPollingWorker,
	type ReviewStepResult,
	type StepResult,
} from "./polling-worker.js";
import { runCiCommandStep } from "./steps/ci-step.js";
import { executeTaskStep } from "./steps/execute-step.js";
import { runReviewTaskStep } from "./steps/review-step.js";

function parseEnvInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return fallback;
	}
	return parsed;
}

function parseEnvProvider(): "codex" | "copilot" {
	const provider = process.env.WORKER_PROVIDER;
	return provider === "codex" ? "codex" : "copilot";
}

function parseEnvCommand(name: string, fallback: string): string {
	const value = process.env[name]?.trim();
	return value && value.length > 0 ? value : fallback;
}

async function main(): Promise<void> {
	const apiBaseUrl = process.env.WORKER_API_BASE_URL ?? "http://localhost:3000";
	const pollIntervalMs = parseEnvInt("WORKER_POLL_INTERVAL_MS", 1000);
	const runTimeoutMs = parseEnvInt("WORKER_RUN_TIMEOUT_MS", 120000);
	const provider = parseEnvProvider();
	const model = process.env.WORKER_MODEL ?? "gpt-5.3-codex";
	const ciCommand = parseEnvCommand(
		"WORKER_CI_COMMAND",
		"npm run lint && npm run typecheck && npm run test && npm run build",
	);
	const ciTimeoutMs = parseEnvInt("WORKER_CI_TIMEOUT_MS", Math.min(runTimeoutMs, 90000));
	const ciLogMaxChars = parseEnvInt("WORKER_CI_LOG_MAX_CHARS", 4000);

	const apiClient = createHttpWorkerApiClient({ baseUrl: apiBaseUrl });
	const worker = createPollingWorker({
		apiClient,
		pollIntervalMs,
		runTimeoutMs,
		steps: {
			async execute(task): Promise<StepResult> {
				return executeTaskStep({
					taskId: task.taskId,
					runId: task.runId,
					provider,
					model,
					timeoutMs: Math.min(runTimeoutMs, 30000),
					tokenLimits: {
						maxInputTokens: 4000,
						maxOutputTokens: 1200,
					},
				});
			},
			async ci(): Promise<StepResult> {
				return runCiCommandStep({
					command: ciCommand,
					timeoutMs: Math.min(ciTimeoutMs, runTimeoutMs),
					maxLogChars: ciLogMaxChars,
					cwd: process.cwd(),
				});
			},
			async review(_task, reviewInput): Promise<ReviewStepResult> {
				return runReviewTaskStep({
					provider,
					model,
					timeoutMs: Math.min(runTimeoutMs, 30000),
					tokenLimits: {
						maxInputTokens: 3000,
						maxOutputTokens: 800,
					},
					changeSummary: reviewInput.changeSummary,
					ciSummary: reviewInput.ciSummary,
				});
			},
		},
	});

	worker.start();
	console.log(`[worker] started (${packageId})`, {
		apiBaseUrl,
		pollIntervalMs,
		runTimeoutMs,
		provider,
		model,
		ciCommand,
		ciTimeoutMs,
		ciLogMaxChars,
	});

	const shutdown = async (signal: string): Promise<void> => {
		await worker.stop();
		console.log(`[worker] shutdown (${packageId})`, { signal });
	};

	process.on("SIGINT", () => {
		void shutdown("SIGINT");
	});

	process.on("SIGTERM", () => {
		void shutdown("SIGTERM");
	});
}

void main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`[worker] operation=main error=${message}`);
	process.exitCode = 1;
});