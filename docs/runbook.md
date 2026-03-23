# Runbook: Failure Triage, Retry, and Rollback

This runbook covers operational triage for this repository:
- failed CI
- failed review
- failed deploy

It is mapped to the current workflows and scripts in:
- `.github/workflows/ci.yml`
- `.github/workflows/cd.yml`
- root `package.json` scripts

## Quick References

- CI workflow: `.github/workflows/ci.yml`
- CD workflow: `.github/workflows/cd.yml`
- Root quality gate: `npm run ci`
- Root checks:
  - `npm run lint`
  - `npm run typecheck`
  - `npm run test`
  - `npm run coverage`
  - `npm run build`
- Web integration tests: `npm run test:integration --workspace @the-foundry/web`
- Worker tests: `npm run test --workspace @the-foundry/worker`
- Migrations SQL:
  - `migrations/0001_core_workflow_tables.sql`
  - `migrations/0002_run_completion_columns.sql`
- API routes (web app):
  - `GET /api/tasks`
  - `GET /api/tasks/:taskId`
  - `POST /api/findings`
  - `POST /api/tasks/:taskId/approve`
  - `POST /api/tasks/claim`
  - `POST /api/runs/:runId/complete`
- Queue UI routes:
  - `GET /queue`
  - `GET /tasks/:taskId`

## 1) Failed CI Triage (GitHub Actions CI)

### Trigger and gate behavior
1. CI runs on pull requests and pushes to `main` via `.github/workflows/ci.yml`.
2. CI executes `npm ci` then `npm run ci`.
3. `npm run ci` is a strict chain:
   - lint -> typecheck -> test -> coverage -> build
4. `CI=true`, `DATABASE_URL`, and `TEST_DATABASE_URL` are set in CI for tests.

### Triage steps
1. Open the failed CI run and identify the first failing command in the `Quality Gates` step.
2. Reproduce locally from repo root:
   - `npm ci`
   - `npm run ci`
3. If full `ci` output is noisy, isolate the failing stage:
   - `npm run lint`
   - `npm run typecheck`
   - `npm run test`
   - `npm run coverage`
   - `npm run build`
4. If failure is integration-test related, verify DB env vars are present and rerun:
   - `npm run test:integration --workspace @the-foundry/web`
5. If failure points to DB schema/columns, verify migration SQL files in `migrations/` and confirm integration migration helper behavior in `apps/web/src/integration-test-db.ts`.

### Retry procedure
1. Push a fix commit.
2. Re-run CI by pushing again or using the GitHub Actions rerun button for the failed workflow.
3. Confirm green `Quality Gates` before re-requesting review.

### Rollback procedure (for CI regressions on `main`)
1. Identify the last known-good commit on `main`.
2. Revert the breaking commit(s) with `git revert` (prefer revert over reset for shared history).
3. Push the revert commit to `main` (or merge via PR per branch policy).
4. Confirm CI passes on the revert commit.

## 2) Failed Review Triage

This repository has two common review-failure modes:
- PR/code-review process failure (requested changes, blocked merge)
- task lifecycle review decision failure in run artifacts

### A. PR/code-review failure
1. Open PR review comments and required checks.
2. Verify branch protection expectations in `docs/repository-setup.md`.
3. Re-run local quality checks before updating PR:
   - `npm run ci`
4. Address review comments and push follow-up commit(s).

Retry:
1. Re-request review after all required checks are green.

Rollback:
1. If a reviewed change was merged and is faulty, revert via `git revert` and re-run `npm run ci`.

### B. Task lifecycle review failure (run-level)

Use this path when a task run failed review in the app lifecycle.

Triage:
1. Inspect task details from API:
   - `GET /api/tasks/:taskId`
2. Check `latestRun.review` and `latestRun.artifactSummaries` for review rationale.
3. Use read-only evidence only:
   - task detail API payload from `GET /api/tasks/:taskId`
   - queue/task UI pages (`GET /queue`, `GET /tasks/:taskId`)
   - artifact locations listed in `latestRun.artifactSummaries` (for example CI logs and review decision payloads)
4. Do not call `POST /api/runs/:runId/complete` for inspection; it mutates run/task state.
5. Validate worker/web integration behavior by running relevant tests:
   - `npm run test --workspace @the-foundry/worker`
   - `npm run test:integration --workspace @the-foundry/web`

Retry:
1. Re-approve failed task for retry:
   - `POST /api/tasks/:taskId/approve` with `{ "mode": "manual_retry" }`
2. Allow worker to claim and process again through:
   - `POST /api/tasks/claim`

Rollback:
1. There is no dedicated "undo run" script.
2. Operational rollback is to stop forward processing and revert the code change that introduced review failures, then retry failed tasks with `manual_retry`.

## 3) Failed Deploy Triage (GitHub Actions CD)

### Trigger and path behavior
1. CD is defined in `.github/workflows/cd.yml`.
2. CD runs when:
   - CI workflow completes successfully on `main` (`workflow_run`), or
   - manually via `workflow_dispatch`.
3. CD gate job decides if pipeline should proceed.
4. Prepare job builds and chooses one of two paths:
   - deploy path if deploy config and `DEPLOY_TOKEN` secret are present
   - artifact fallback path otherwise

### Triage steps
1. Check `gate` job output for trigger mismatch (not successful CI on `main` unless manual dispatch).
2. Check `prepare` job:
   - did `npm ci` and `npm run build` pass?
   - what is `path_reason`?
3. If deploy path was expected, confirm required inputs exist:
   - deploy config file: `.github/deploy.yml` or `deploy/config.yml`
   - secret: `DEPLOY_TOKEN`
4. If fallback path was used, verify artifact upload succeeded and download artifact bundle from workflow artifacts.
5. If deploy command itself fails, inspect output of:
   - `npm run deploy --if-present`
   and verify whether a `deploy` script exists in `package.json`.

### Retry procedure
1. Fix missing config/secret or deploy script issue.
2. Re-run CD with `workflow_dispatch`, or re-run after a new successful CI on `main`.
3. Confirm either:
   - deploy job succeeds, or
   - artifact fallback publishes expected tarball and metadata.

### Rollback procedure
1. There is no repository-defined automated production rollback script in current workflows.
2. Use safe rollback by code reversion:
   - revert to last known-good commit with `git revert`
   - let CI pass
   - trigger CD again (automatic on successful main CI, or manual dispatch)
3. If artifact fallback is your release source, select and redeploy a previously known-good artifact from prior workflow runs.

## 4) Flaky Test Handling (CI and PR Reviews)

Use this when a test fails once, then passes without code changes.

### Identify likely flake
1. Capture the exact failing test name/file and failing job from the CI run.
2. Re-run the narrowest local command first:
   - Shared package: `npm run test --workspace @the-foundry/shared`
   - Worker package: `npm run test --workspace @the-foundry/worker`
   - Web unit tests: `npm run test --workspace @the-foundry/web`
   - Web integration tests: `npm run test:integration --workspace @the-foundry/web`
3. Run the same command one additional time with no code changes.
4. Treat as likely flaky only when one run fails and the immediate rerun passes with identical inputs.

### Bounded rerun policy
1. Local reruns: maximum 1 additional rerun of the same failing command.
2. GitHub Actions reruns: maximum 1 workflow rerun for the same commit.
3. If the failure repeats after the bounded rerun, classify as real regression (not flake) and fix before merge.

### Quarantine and escalation
1. If likely flaky and root cause cannot be fixed quickly, quarantine the test with a targeted skip in the owning test file (for example `test.skip(...)`), limited to the specific case.
2. In the same PR, add a follow-up tracking item in `tasks/v1_tasks.json` and link it in the PR description.
3. Escalate by assigning an owner and priority for flake removal before the next release cycle.

### Merge-block decision criteria
1. Block merge when any required check remains red, or when the test failure is reproducible after bounded reruns.
2. Allow merge only when all required checks are green and either:
   - the flake is fixed, or
   - the flake is quarantined with a linked follow-up task and clear owner.
3. If quarantine is used, include explicit evidence in PR notes: failing run URL, passing rerun URL, and quarantine diff.

## Migrations and DB Notes

- Integration helpers apply migrations in order from `migrations/` via `apps/web/src/integration-test-db.ts`.
- Current migration files:
  - `0001_core_workflow_tables.sql`
  - `0002_run_completion_columns.sql`
- There is no root `npm run migrate` script currently.

If you run DB checks manually outside tests (for example with `psql`), treat those as environment-specific operations and document the exact command used in incident notes.

## Incident Checklist (Concise)

1. Capture failing workflow run URL and failing step.
2. Reproduce with repo scripts (`npm run ci` or `npm run build` as applicable).
3. Isolate root cause (code, tests, config, secret, workflow gate).
4. Apply fix and retry via the mapped workflow trigger.
5. If risk is high or outage persists, rollback with `git revert` to last known-good and re-run CI/CD.
6. Record outcome and any follow-up hardening tasks.
