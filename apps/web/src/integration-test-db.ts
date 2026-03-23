import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";

const INTEGRATION_TABLES = ["artifacts", "runs", "tasks", "findings"] as const;

function getMigrationsDir(): string {
	const thisFile = fileURLToPath(import.meta.url);
	const thisDir = path.dirname(thisFile);
	return path.resolve(thisDir, "../../../migrations");
}

export function resolveIntegrationDatabaseUrl(): string | null {
	return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? null;
}

export function createIntegrationPool(connectionString: string): Pool {
	return new Pool({ connectionString });
}

export async function applyMigrations(client: PoolClient): Promise<void> {
	const migrationsDir = getMigrationsDir();
	const migrationFiles = ["0001_core_workflow_tables.sql", "0002_run_completion_columns.sql"];

	for (const migrationFile of migrationFiles) {
		const migrationPath = path.join(migrationsDir, migrationFile);
		const sql = await readFile(migrationPath, "utf8");
		await client.query(sql);
	}
}

export async function resetIntegrationTables(client: PoolClient): Promise<void> {
	await client.query(`TRUNCATE TABLE ${INTEGRATION_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}