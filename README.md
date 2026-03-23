# The Foundry

The Foundry is a Node.js and TypeScript monorepo with:

- A web service in apps/web
- A polling worker in apps/worker
- Shared contracts and utilities in packages/shared

The system ingests findings, creates and manages task lifecycle state, and processes tasks through execute, CI, and review steps.

## Repository Layout

- apps/web: HTTP API + lightweight UI pages
- apps/worker: Polling worker and step orchestration
- packages/shared: Shared types, state machine, and provider contracts
- migrations: Postgres schema migrations
- docs: Standards, contracts, setup notes, and runbook

## Prerequisites

- Node.js 20+
- npm 10+
- PostgreSQL 16+

## Quick Start

1. Install dependencies

```bash
npm install
```

2. Start PostgreSQL and create a local database

```bash
createdb the_foundry
```

3. Create a local environment file

```bash
cp .env.example .env
```

4. Load environment variables in your shell

```bash
set -a
source .env
set +a
```

5. Apply migrations

```bash
psql "$DATABASE_URL" -f migrations/0001_core_workflow_tables.sql
psql "$DATABASE_URL" -f migrations/0002_run_completion_columns.sql
```

6. Start web + worker together

```bash
npm run start
```

The app starts on http://localhost:3000 by default.

## .env File

Create a .env file in the repository root. Use this as a baseline:

```bash
DATABASE_URL=postgresql://localhost:5432/the_foundry

# Optional for integration tests
TEST_DATABASE_URL=postgresql://localhost:5432/the_foundry_test

# Optional web override
# PORT=3000

# Optional worker overrides
# WORKER_API_BASE_URL=http://localhost:3000
# WORKER_POLL_INTERVAL_MS=1000
# WORKER_RUN_TIMEOUT_MS=120000
# WORKER_PROVIDER=copilot
# WORKER_MODEL=gpt-5.3-codex
# WORKER_CI_COMMAND=npm run lint && npm run typecheck && npm run test && npm run build
# WORKER_CI_TIMEOUT_MS=90000
# WORKER_CI_LOG_MAX_CHARS=4000
```

## UI and API Usage

### UI pages

- Queue page: http://localhost:3000/queue
- Task detail page: http://localhost:3000/tasks/:taskId

### Core API routes

- POST /api/findings
- GET /api/tasks
- GET /api/tasks/:taskId
- POST /api/tasks/:taskId/approve
- POST /api/tasks/claim
- POST /api/runs/:runId/complete

## Environment Variables

### Web service

- DATABASE_URL (required): Postgres connection string
- PORT (optional): default 3000

### Worker

- WORKER_API_BASE_URL (optional): default http://localhost:3000
- WORKER_POLL_INTERVAL_MS (optional): default 1000
- WORKER_RUN_TIMEOUT_MS (optional): default 120000
- WORKER_PROVIDER (optional): codex or copilot, default copilot
- WORKER_MODEL (optional): default gpt-5.3-codex
- WORKER_CI_COMMAND (optional): default npm run lint && npm run typecheck && npm run test && npm run build
- WORKER_CI_TIMEOUT_MS (optional): timeout for CI step
- WORKER_CI_LOG_MAX_CHARS (optional): bounded CI log artifact size

## Development Commands

- Run web + worker: npm run start
- Run web only: npm run start:web
- Run worker only: npm run start:worker
- Lint: npm run lint
- Typecheck: npm run typecheck
- Unit + integration tests: npm run test
- Build all packages: npm run build
- Coverage gates for critical modules: npm run coverage
- Full local CI parity command: npm run ci

## Integration Tests

Integration tests require Postgres.

For local runs:

```bash
export TEST_DATABASE_URL='postgresql://localhost:5432/the_foundry_test'
npm run test:integration
```

If TEST_DATABASE_URL is not set, integration tests are skipped locally.
In CI mode (CI=true), missing DB configuration causes integration tests to fail fast.

## CI/CD

- CI workflow: .github/workflows/ci.yml
  - Runs lint, typecheck, test, coverage, and build
  - Uses a Postgres service in GitHub Actions
- CD workflow: .github/workflows/cd.yml
  - Runs after successful CI on main
  - Deploys when deploy config and secret are present
  - Otherwise publishes versioned build artifacts and metadata

## Troubleshooting

- See docs/runbook.md for failure triage, retries, flaky test handling, and rollback procedures.
- See docs/repository-setup.md for branch protection and repository setup guidance.
