# The Foundry — Copilot Instructions

This is the development instructions for The Foundry codebase itself.
All AI agents (Copilot in IDE, SDK agents, and automated workers) should follow these guidelines.

## Project Overview

The Foundry is an AI-powered task orchestration system. It consists of:
- **apps/web** — NextJS 15 control panel (App Router, Server Components, Server Actions)
- **packages/db** — Shared Prisma schema and database client
- **services/worker** — Node.js worker that polls for tasks and runs Copilot SDK sessions

## Architecture Rules

- This is an npm workspaces monorepo managed by Turborepo.
- Cross-package imports use workspace protocol: `@the-foundry/db`.
- All packages use ESM (`"type": "module"`).
- Database access goes through `@the-foundry/db` — never import Prisma directly.

## Code Standards

### TypeScript
- Strict mode is enforced (`strict: true` in tsconfig).
- Use `type` imports for type-only imports: `import type { Foo } from "bar"`.
- No `any` — use `unknown` and narrow. The `@typescript-eslint/no-explicit-any` rule is set to warn.
- Enable `noUncheckedIndexedAccess` — always check array/object access results.
- Prefer `const` assertions and discriminated unions over enums in application code (Prisma enums are fine).

### React / NextJS
- Use Server Components by default. Add `"use client"` only when needed.
- Use Server Actions for mutations (form submissions, status changes).
- Keep components small and composable — one file per component.
- Use Tailwind CSS for styling. No CSS modules, no styled-components.
- API routes are only for external consumers (the worker). UI uses Server Actions.

### Database
- Schema uses `@@map` for snake_case table/column names. TypeScript models use camelCase.
- Always cascade deletes from parent entities.
- Add indexes on foreign keys and frequently queried columns.
- Use transactions for multi-step mutations.

### Worker / SDK
- Agent definitions live in `services/worker/src/agents/`.
- Each agent is a single export with `name`, `displayName`, `description`, `tools`, and `prompt`.
- The orchestrator agent should be the entry point — it delegates to planner → implementer → reviewer.
- Memory context is budget-limited (2000 tokens max) — see `memory.ts`.

## Error Handling
- Let errors propagate to the nearest boundary (API route, Server Action, worker catch block).
- Log errors with context: include task ID, project ID, and operation name.
- Do not silently swallow errors.

## Testing
- Use Vitest for all tests.
- Test files go next to the code they test: `foo.ts` → `foo.test.ts`.
- Focus tests on business logic, not framework wiring.

## Git Conventions
- Branch naming: `foundry/task-{id}` for automated branches, `feat/`, `fix/`, `chore/` for manual work.
- Commit messages: imperative mood, concise. E.g., "Add task approval endpoint".
- One logical change per commit.

## Security
- Never commit secrets or tokens. Use environment variables.
- Validate all external input at API route boundaries.
- The worker's `onPreToolUse` hook should log all tool calls for audit.
- Restrict file access in agent sessions to the working directory only.
