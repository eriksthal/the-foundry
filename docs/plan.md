# The Foundry — System Architecture & Implementation Plan

**Last updated:** 2026-03-23
**Status:** Phase 1 — Foundation

---

## 1. Vision

The Foundry is an AI-powered task orchestration system that uses the GitHub Copilot SDK to autonomously execute coding tasks across repositories. A human approves a task, The Foundry plans, implements, reviews, and delivers a pull request — consuming a single Copilot premium request per task.

The long-term goal is for The Foundry to build itself: agents write most of the code, guided by strict governance, memory of past mistakes, and project-specific conventions.

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     NextJS App (:3000)                       │
│                                                             │
│  [Dashboard] ──→ [Projects] ──→ [Tasks] ──→ [Detail View]  │
│                        │              │            ↑        │
│                   Server Actions  Approve     Status/Logs   │
│                                       │            │        │
│              ┌────── API Routes ──────┼────────────┤        │
│              │  /api/tasks/approved   │            │        │
│              │  /api/tasks/[id]       │            │        │
│              │  /api/tasks/[id]/logs  │            │        │
└──────────────┼────────────────────────┼────────────┼────────┘
               │                        │            │
      ┌────────▼────────┐              │            │
      │   PostgreSQL     │◄─────────────┘────────────┘
      │                  │
      │  projects        │
      │  tasks           │
      │  execution_logs  │
      │  project_memory  │
      │  task_feedback   │
      └────────┬────────┘
               │
      ┌────────▼────────┐
      │  Node Worker     │
      │                  │
      │  1. Poll DB for  │
      │     approved     │
      │     tasks        │
      │  2. Clone repo   │
      │     into tmpdir  │
      │  3. Load agents  │
      │     + memory     │
      │  4. Create       │
      │     Copilot      │
      │     session      │
      │  5. sendAndWait  │
      │  6. Update DB    │
      │  7. Cleanup      │
      └────────┬────────┘
               │
      ┌────────▼────────┐
      │  Copilot CLI     │
      │  (auto-managed   │
      │   by SDK)        │
      └─────────────────┘
```

### Component Responsibilities

| Component | Role | Stack |
|-----------|------|-------|
| **apps/web** | Control panel — project/task CRUD, approval flow, results display | NextJS 15, App Router, Tailwind CSS, Server Actions |
| **packages/db** | Shared database schema and Prisma client | Prisma 6, PostgreSQL 16 |
| **services/worker** | Polls for approved tasks, runs Copilot SDK sessions, reports results | Node.js, @github/copilot-sdk, tsx |

### Data Flow

1. User creates a **Project** (links to a GitHub repo URL)
2. User creates a **Task** on that project (description of work to do)
3. User moves task through: `DRAFT → PENDING_APPROVAL → APPROVED`
4. Worker picks up `APPROVED` task → sets to `IN_PROGRESS`
5. Worker clones repo, creates branch, starts Copilot session
6. Orchestrator agent delegates to planner → implementer → reviewer
7. All tool calls are logged to `execution_logs`
8. On success: task → `COMPLETED`, result stored, branch pushed
9. On failure: task → `FAILED`, error log stored
10. User views results in the web UI

---

## 3. Database Schema

### Tables

| Table | Purpose |
|-------|---------|
| `projects` | GitHub repos to work on. Has name, repo URL, default branch. |
| `tasks` | Units of work. Has title, description, status, branch, PR URL, result. |
| `execution_logs` | Every tool call and sub-agent event during task execution. |
| `project_memory` | Lessons learned per project — injected into future sessions. |
| `task_feedback` | Human feedback on completed tasks — feeds into project memory. |

### Task Status Flow

```
DRAFT → PENDING_APPROVAL → APPROVED → IN_PROGRESS → COMPLETED
                                              │
                                              └──→ FAILED
```

---

## 4. Agent Architecture

### Agent Hierarchy

```
Orchestrator (entry point — all tools)
  ├── Planner (read-only tools)
  ├── Implementer (read + write + bash tools)
  └── Reviewer (read + bash tools)
```

### Agent Definitions

Agents are defined in `services/worker/src/agents/`. Each is a TypeScript module exporting:

```typescript
{
  name: string;          // Unique identifier
  displayName: string;   // Human-readable name
  description: string;   // What it does (used for auto-delegation)
  tools?: string[];      // Allowed tools (null = all)
  prompt: string;        // System prompt
}
```

### How Delegation Works

The Copilot SDK runtime auto-delegates to sub-agents based on intent matching:

1. The orchestrator receives the task prompt
2. When the orchestrator's reasoning requires analysis, the runtime delegates to the planner
3. When implementation is needed, the runtime delegates to the implementer
4. For review, the runtime delegates to the reviewer
5. All sub-agent events stream back to the parent session
6. The result integrates into the orchestrator's response

**This entire flow happens within a single `sendAndWait()` call = single premium request.**

### SDK ↔ IDE Instruction Mapping

| IDE Feature | SDK Equivalent |
|-------------|----------------|
| `copilot-instructions.md` in repo | Read via `onSessionStart` hook's `additionalContext` + CLI reads it natively when working in the repo directory |
| `.github/agents/*.md` | `customAgents` array on session creation |
| `.github/copilot-instructions.md` | Same as above — read and inject via hooks |
| `SKILL.md` files | Can be loaded and injected via `additionalContext` |
| Tool restrictions per mode | `tools` array per custom agent |
| `@agent` mentions | `agent` field on session config (pre-selects agent) |

---

## 5. Memory System

### Design Principles

- Memory is a **priority queue with a fixed output window**, not a log
- Hard budget: **2,000 tokens** max injected per session
- Entries are ranked by: confidence → times reinforced → recency
- Auto-detected entries are capped at **30 per project**
- Human-written entries never decay

### Memory Categories

| Category | Purpose | Example |
|----------|---------|---------|
| `MISTAKE` | Things to avoid | "Tests fail if DB_URL is not set" |
| `CONVENTION` | Project patterns to follow | "Use barrel exports in index.ts" |
| `PATTERN` | Established code patterns | "API routes return NextResponse.json()" |
| `GOTCHA` | Non-obvious traps | "The auth middleware must run before rate limiting" |

### Memory Sources (Phase 2+)

1. **Human feedback** — User writes lessons after reviewing a PR (highest confidence)
2. **Auto-detected** — Worker hooks detect patterns like test failures (medium confidence)
3. **Reviewer agent** — Can output structured lessons (medium confidence, deduped)

### Deduplication

At write time, new entries are compared to existing entries using word-overlap similarity (Jaccard). If similarity > 0.8, the existing entry is reinforced (confidence + count incremented) instead of creating a duplicate.

### Decay

Auto-detected entries not reinforced or used in 30 days lose 0.1 confidence. Entries below 0.1 are deactivated. Human entries never decay.

---

## 6. Governance & Quality

### For The Foundry's Own Codebase

- `copilot-instructions.md` at repo root — read by IDE Copilot when developing The Foundry
- TypeScript strict mode with `noUncheckedIndexedAccess`
- ESLint flat config with `@typescript-eslint` rules
- Prettier for consistent formatting
- Vitest for testing
- Turborepo for build orchestration

### For Target Repositories (repos agents work on)

Agents are instructed to:
1. Read the repo's `copilot-instructions.md` / `CONTRIBUTING.md` / `README.md` first
2. Follow existing code conventions (naming, structure, patterns)
3. Run existing linters and tests
4. Not refactor unrelated code
5. All tool calls are logged for audit

### Code Quality Pipeline (Current)

```
npm run typecheck    → tsc --noEmit across all packages
npm run lint         → ESLint across all packages
npm run format:check → Prettier check
npm run test         → Vitest across all packages
```

### Code Quality Pipeline (CI/CD — Future)

```yaml
# .github/workflows/ci.yml (planned)
on: [push, pull_request]
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run format:check
      - run: npm run test:ci
```

---

## 7. Phases

### Phase 1: Foundation ✅ (Current)

| # | Task | Status |
|---|------|--------|
| 1.1 | Monorepo scaffold (npm workspaces, turbo, TS, ESLint, Prettier) | ✅ |
| 1.2 | Prisma schema (projects, tasks, logs, memory, feedback) | ✅ |
| 1.3 | Docker Compose for Postgres | ✅ |
| 1.4 | NextJS app — dashboard, project CRUD, task CRUD, approval flow | ✅ |
| 1.5 | API routes for worker callbacks | ✅ |
| 1.6 | Worker service — polling loop, task runner | ✅ |
| 1.7 | Agent definitions (orchestrator, planner, implementer, reviewer) | ✅ |
| 1.8 | Memory context builder (budgeted, ranked) | ✅ |
| 1.9 | Copilot instructions & governance docs | ✅ |
| 1.10 | Plan document | ✅ |

**To start using Phase 1:**
1. Start Postgres: `docker compose up -d`
2. Set up `.env` with `DATABASE_URL`
3. Run `npm install` then `npm run db:push`
4. Start web: `npm run dev` (opens :3000)
5. Start worker: `npm run worker:dev`
6. Create a project → create a task → approve it → watch the worker pick it up

### Phase 2: Observability & Feedback

| # | Task | Details |
|---|------|---------|
| 2.1 | Execution timeline UI | Visual timeline of tool calls and sub-agent events per task |
| 2.2 | Agent activity tree | Tree view showing orchestrator → planner → implementer → reviewer flow |
| 2.3 | PR link integration | Use GitHub MCP server to create PRs, store URL on task |
| 2.4 | Task feedback form | Rating, what went right/wrong, lessons learned |
| 2.5 | Memory write pipeline | Human feedback → dedup → project_memory table |
| 2.6 | Auto-detected memory | Hook-based pattern detection (test failures, common errors) |
| 2.7 | Memory management UI | View, edit, delete, promote/demote memories per project |

### Phase 3: Configurable Agents via UI

| # | Task | Details |
|---|------|---------|
| 3.1 | Agent config DB schema | `agent_configs` table with version history |
| 3.2 | Agent config editor | Form UI for creating/editing agent prompts and tools |
| 3.3 | Per-project agent overrides | Project-specific prompts that override global defaults |
| 3.4 | Config versioning | Audit trail of all prompt/tool changes with rollback |
| 3.5 | Prompt testing sandbox | Test an agent prompt against a repo without creating a real task |

### Phase 4: Containers & Scale

| # | Task | Details |
|---|------|---------|
| 4.1 | Dockerized task runner | Ephemeral container per task with CLI pre-installed |
| 4.2 | Queue-based processing | BullMQ/Redis replacing DB polling |
| 4.3 | Concurrent task limits | Per-project and global concurrency controls |
| 4.4 | Warm container pool | Pre-started containers with CLI ready |
| 4.5 | WebSocket status updates | Real-time task progress in the UI |
| 4.6 | Cost tracking | Premium requests consumed per task |

### Phase 5: Self-Building

| # | Task | Details |
|---|------|---------|
| 5.1 | The Foundry as a project | Point The Foundry at its own repo |
| 5.2 | Automated issue → task pipeline | GitHub issues auto-create tasks |
| 5.3 | CI/CD integration | Tasks only complete when CI passes |
| 5.4 | Multi-agent review | Multiple reviewer agents with different focus areas |
| 5.5 | Adaptive prompts | Agent prompts evolve based on success rate per project |

---

## 8. Environment Setup

### Prerequisites

- Node.js 18+
- npm (included with Node)
- Docker (for Postgres; or use a managed Postgres instance)
- Copilot CLI (`copilot --version` should work)
- GitHub token with repo access

### Environment Variables

```bash
# .env
DATABASE_URL="postgresql://foundry:foundry_dev@localhost:5432/the_foundry"
COPILOT_GITHUB_TOKEN=""   # Your GitHub token for Copilot SDK
GITHUB_TOKEN=""           # For git clone/push operations
```

### Quick Start

```bash
# 1. Clone and install
cd /Users/esthal/dev/the-foundry
npm install

# 2. Start Postgres
docker compose up -d

# 3. Push schema to database
npm run db:push

# 4. Generate Prisma client
npm run db:generate

# 5. Start the web app
cd apps/web && npm run dev

# 6. Start the worker (new terminal)
cd services/worker && npm run dev
```

---

## 9. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **npm workspaces** over pnpm/yarn | Already installed, simpler setup, workspace protocol works |
| **Server Actions** over tRPC | Built into NextJS, no extra deps, works with progressive enhancement |
| **Direct Prisma** over API layer | Phase 1 simplicity; extract service layer when testing demands it |
| **Local runner** first, Docker later | No Docker installed yet; dual-mode runner added in Phase 4 |
| **Agent prompts in code** | Version controlled, fast iteration, moved to DB in Phase 3 |
| **Single premium request** | Orchestrator + sub-agents within one `sendAndWait()` call |
| **Memory budget (2000 tokens)** | Prevents context window bloat; priority queue, not append-only log |
| **Vitest** over Jest | Faster, ESM-native, better TS support |

---

## 10. Risk Log

| Risk | Mitigation |
|------|------------|
| SDK is in Technical Preview | Pin SDK version, test upgrades in isolation |
| Single `sendAndWait` may hit context limits on large repos | Start with focused tasks; add chunking in Phase 2 |
| Agent may produce incorrect code | Reviewer agent + human PR review + CI pipeline |
| Worker crash loses in-progress state | Task has `IN_PROGRESS` status; restart picks up where it left off |
| Uncontrolled shell commands | `onPreToolUse` logging; path restrictions; Docker isolation in Phase 4 |
| Memory table grows unbounded | Hard cap of 30 auto entries, decay, dedup at write time |

---

## 11. File Structure Reference

```
the-foundry/
├── apps/
│   └── web/                          # NextJS control panel
│       ├── app/
│       │   ├── globals.css
│       │   ├── layout.tsx            # Root layout with nav
│       │   ├── page.tsx              # Dashboard
│       │   ├── projects/
│       │   │   ├── page.tsx          # Project list
│       │   │   ├── new/page.tsx      # Create project form
│       │   │   └── [id]/page.tsx     # Project detail + tasks
│       │   ├── tasks/
│       │   │   └── [id]/page.tsx     # Task detail view
│       │   └── api/
│       │       └── tasks/
│       │           ├── approved/route.ts  # GET approved tasks
│       │           └── [id]/
│       │               ├── route.ts       # PATCH task status
│       │               └── logs/route.ts  # POST execution logs
│       ├── next.config.ts
│       ├── postcss.config.mjs
│       ├── tsconfig.json
│       └── package.json
├── packages/
│   └── db/                           # Shared Prisma schema
│       ├── prisma/
│       │   └── schema.prisma
│       ├── src/
│       │   └── index.ts              # Prisma client + re-exports
│       ├── tsconfig.json
│       └── package.json
├── services/
│   └── worker/                       # Task processing worker
│       ├── src/
│       │   ├── index.ts              # Polling loop
│       │   ├── runner.ts             # Task execution (clone, session, push)
│       │   ├── memory.ts             # Memory context builder
│       │   └── agents/
│       │       ├── index.ts          # Agent loader
│       │       ├── orchestrator.ts
│       │       ├── planner.ts
│       │       ├── implementer.ts
│       │       └── reviewer.ts
│       ├── tsconfig.json
│       └── package.json
├── docs/
│   └── plan.md                       # This file
├── .env.example
├── .eslintrc.mjs
├── .gitignore
├── .prettierrc
├── .prettierignore
├── copilot-instructions.md           # Agent governance
├── docker-compose.yml                # Postgres
├── package.json                      # Workspace root
├── tsconfig.base.json                # Shared TS config
└── turbo.json                        # Turborepo config
```
