# The Foundry

An AI-powered task orchestration system that uses the GitHub Copilot SDK to autonomously plan, implement, review, and deliver pull requests — consuming a single Copilot premium request per task.

## Architecture

```
┌─ Next.js App (Port 3000) ────────────────────┐
│  Dashboard → Projects → Tasks → Detail View   │
│         Server Actions + API Routes            │
└────────────────────────────────────────────────┘
                      ↓
┌─ PostgreSQL Database ─────────────────────────┐
│  projects · tasks · execution_logs             │
│  project_memory · task_feedback                │
└────────────────────────────────────────────────┘
                      ↓
┌─ Node.js Worker Service ──────────────────────┐
│  Polls DB → Clones Repo → Copilot Session      │
│  Runs 4-Agent Orchestration Pipeline           │
└────────────────────────────────────────────────┘
```

## Tech Stack

| Component    | Technology                                       |
| ------------ | ------------------------------------------------ |
| **Frontend** | Next.js 15 (App Router), React Server Components, Tailwind CSS |
| **Backend**  | Next.js API Routes, Server Actions               |
| **Database** | PostgreSQL 16, Prisma 6                          |
| **Worker**   | Node.js, `@github/copilot-sdk`                   |
| **Build**    | Turborepo, npm workspaces, TypeScript 5.7 (strict) |
| **Linting**  | ESLint 9, Prettier 3                             |


## Environment Setup

### FOUNDRY_SECRETS_KEY

You **must** set a `FOUNDRY_SECRETS_KEY` in your root `.env` file. This key is required for all encryption/decryption of secrets in the system.

- **How to generate a suitable key:**
    - Run: `openssl rand -base64 32`
    - Copy the output and add to your `.env`:
        ```env
        FOUNDRY_SECRETS_KEY=...your_base64_key...
        ```
- The key must be exactly 32 bytes (base64-encoded).
- Ensure your **worker** and all **API routes** that use secrets load this variable. In local dev, call `dotenv.config()` in your entrypoint before using any code that imports `@the-foundry/db/src/secrets`.

### API Input Validation

It is **recommended** to use [Zod](https://zod.dev/) for validating all API input. This helps prevent invalid or unsafe data from reaching your backend logic.

## Monorepo Structure

```
apps/web/            # Next.js 15 control panel
packages/db/         # Shared Prisma schema & client (@the-foundry/db)
services/worker/     # Node.js worker service
```

## Agent Pipeline

All four agents run within a single Copilot SDK session:

1. **Orchestrator** — Coordinates the workflow; delegates to the other agents in sequence.
2. **Planner** — Read-only analysis of the codebase; produces a step-by-step implementation plan.
3. **Implementer** — Executes the plan: writes code, runs linters and tests, fixes issues.
4. **Reviewer** — Quality gate checking correctness, security (OWASP), style, tests, and edge cases.

## Project Memory

The system learns from past tasks via a memory system:

- **Categories:** `PATTERN`, `MISTAKE`, `CONVENTION`, `GOTCHA`
- **Budget:** Up to 2,000 tokens of memory injected per task session
- **Lifecycle:** Sorted by confidence and reinforcement; can expire; fed from human feedback

## Getting Started

### Prerequisites

- Node.js 22+ for the worker runtime
- Docker (for PostgreSQL)
- A GitHub token with repo access

Note: the current GitHub Copilot SDK stack used by the worker expects a Node runtime that supports the `node:sqlite` builtin module. If you run the worker on older Node 20 builds, Copilot session startup can fail before any checkout, editing, review, or PR creation begins.

### Setup

```bash
# Install dependencies
npm install

# Start PostgreSQL
docker compose up -d

# Copy environment variables
cp .env.example .env
# Then fill in GITHUB_TOKEN, COPILOT_GITHUB_TOKEN, and FOUNDRY_APP_URL in .env
# `FOUNDRY_REQUIRE_PULL_REQUEST` defaults to true and fails tasks that finish without a PR
# `FOUNDRY_SETUP_RUN_BUILD` defaults to false so repo-wide builds do not run during worker setup
# `FOUNDRY_DISABLE_AUTH=true` disables Clerk protection for remote debugging only

# Generate Prisma client and push schema
npm run db:generate
npm run db:push

# Start the dev server
npm run dev
```

### Available Scripts

| Script             | Description                        |
| ------------------ | ---------------------------------- |
| `npm run dev`      | Start all services (Turborepo)     |
| `npm run build`    | Build all packages                 |
| `npm run lint`     | Lint all packages                  |
| `npm run typecheck`| Type-check all packages            |
| `npm run test`     | Run tests                         |
| `npm run format`   | Format code with Prettier          |
| `npm run db:generate` | Generate Prisma client          |
| `npm run db:push`  | Push schema to database            |
| `npm run db:migrate` | Run Prisma migrations            |
| `npm run db:studio`| Open Prisma Studio                 |
| `npm run worker:dev` | Start the worker service         |

## Workflow

1. **Create a Project** — Link a GitHub repository.
2. **Create a Task** — Describe the work to be done.
3. **Approve the Task** — Move it from `DRAFT` → `PENDING_APPROVAL` → `APPROVED`.
4. **Worker executes** — Automatically picks up approved tasks, clones the repo, runs the agent pipeline, and pushes a branch.
5. **Review results** — View execution logs, tool calls, PR status, and the final outcome in the dashboard.
6. **Provide feedback** — Rate the task and record lessons learned for future runs.

## License

Private — not licensed for redistribution.
