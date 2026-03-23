import { packageId } from "@the-foundry/shared";

import { createApp } from "./server.js";
import {
	approveTask,
	claimApprovedTask,
	completeRun,
	createFindingAndTask,
	createPoolFromEnv,
	getTaskDetail,
	listTasks,
} from "./db.js";

const DEFAULT_PORT = 3000;

async function main(): Promise<void> {
	let serverClosed = false;

	try {
		const pool = createPoolFromEnv();
		const app = createApp({
			createFindingAndTask: (input) => createFindingAndTask(pool, input),
			listTasks: (input) => listTasks(pool, input),
			getTaskDetail: (taskId) => getTaskDetail(pool, taskId),
			approveTask: (input) => approveTask(pool, input),
			claimApprovedTask: () => claimApprovedTask(pool),
			completeRun: (input) => completeRun(pool, input),
		});

		const portFromEnv = Number(process.env.PORT ?? DEFAULT_PORT);
		const port = Number.isNaN(portFromEnv) ? DEFAULT_PORT : portFromEnv;
		const server = app.listen(port, () => {
			console.log(`[web] started (${packageId})`, { port });
		});

		const shutdown = async (signal: string): Promise<void> => {
			if (serverClosed) {
				return;
			}
			serverClosed = true;
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			await pool.end();
			console.log(`[web] shutdown (${packageId})`, { signal });
		};

		process.on("SIGINT", () => {
			void shutdown("SIGINT");
		});
		process.on("SIGTERM", () => {
			void shutdown("SIGTERM");
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[web] operation=main error=${message}`);
		process.exitCode = 1;
	}
}

void main();