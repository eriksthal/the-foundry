# Coding Standards

This document defines merge requirements for this repository.

## Repository Scope

- Monorepo layout:
- `apps/web`: user-facing application entrypoints.
- `apps/worker`: background processing entrypoints.
- `packages/shared`: reusable code consumed by both apps.
- `tasks`: task definitions and planning artifacts (non-runtime).

## Repository Setup

- Branch protection and required CI checks are defined in `docs/repository-setup.md`.
- For v1, apply required status checks on `main` only.

## Naming Conventions

- Package names must follow `@the-foundry/<name>`.
- Source files in `src` must use `kebab-case.ts`.
- Variables and functions must use `camelCase`.
- Types, interfaces, and classes must use `PascalCase`.
- Constants that are module-level immutable values must use `UPPER_SNAKE_CASE`.
- Exported symbols must have explicit names; do not use default exports in `packages/shared/src`.

## Architecture Boundaries

- `apps/web/src` and `apps/worker/src` may import from `@the-foundry/shared`.
- `packages/shared/src` must not import from `apps/web` or `apps/worker`.
- Cross-app imports are not allowed:
- No import from `apps/web` into `apps/worker`.
- No import from `apps/worker` into `apps/web`.
- Runtime code in `apps/*/src` must not import from `tasks/*`.
- Shared runtime contracts (types, utilities) must live in `packages/shared/src`.

## Error Handling Rules

- Every async boundary (`main`, queue/job handler, external I/O wrapper) must catch errors.
- Caught errors must be logged with context:
- operation name
- input identifier (if available)
- original error message
- Do not throw plain strings; throw `Error` (or subclasses) only.
- Public/shared functions that can throw must include at least one `@throws` JSDoc tag describing the error condition.

## Testing Expectations

- Each behavior change must include one of:
- automated test coverage for new/changed behavior, or
- a PR note explaining why test automation is not feasible.
- At minimum, contributors must run `npm run typecheck` at the repository root before opening a PR.
- When adding logic to `packages/shared`, include tests (or PR rationale) that validate shared behavior independent of app entrypoints.

## Linting

- No ESLint configuration is currently committed.
- Until lint tooling is added, PRs must pass these baseline quality checks:
- no TypeScript compiler errors (`npm run typecheck`)
- no unresolved merge conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
- no unused imports in changed packages (`npm run typecheck --workspace @the-foundry/<pkg> -- --noUnusedLocals` for each changed package)

## Type Safety

- `strict` TypeScript mode is required (already enabled in all workspace `tsconfig.json` files).
- Do not use `any` in new code unless unavoidable; if used, add an inline justification comment.
- Do not use `// @ts-ignore` in new code; use `// @ts-expect-error` with a short reason when suppression is required.
- Public function exports from `packages/shared` must declare explicit parameter types and explicit return types.

## Pull Request Checklist

Before merge, the PR description must include checkboxes and evidence for all items below.

- [ ] `npm run typecheck` was run at repo root and the full command output is included in the PR.
- [ ] For each changed package with TypeScript source edits, `npm run typecheck --workspace @the-foundry/<pkg> -- --noUnusedLocals` was run and output is included.
- [ ] `grep -R -nE "^(<<<<<<<|=======|>>>>>>>)" apps packages tasks docs` returns no matches, and the command result is included.
- [ ] If async boundaries were changed, the PR lists each updated boundary as `path:exportedFunction` and references the matching `catch`/logging implementation.
- [ ] New/changed behavior includes automated tests, or the PR includes a `## Test Exception` section with a concrete reason.