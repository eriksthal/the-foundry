# Repository Setup

This document defines required GitHub repository settings for v1.

## Branch Protection Requirement (v1)

Apply branch protection to `main` only.

Required CI status checks before merge:
- `lint`
- `typecheck`
- `test`
- `build`

These names must match job check names emitted by `.github/workflows/ci.yml`.

## Configure in GitHub UI (manual)

1. Go to **Settings** -> **Branches** in this repository.
2. Under **Branch protection rules**, add or edit the rule for `main`.
3. Enable **Require a pull request before merging**.
4. Enable **Require status checks to pass before merging**.
5. Enable **Require branches to be up to date before merging**.
6. Add these required status checks exactly:
   - `lint`
   - `typecheck`
   - `test`
   - `build`
7. Do not configure bypasses for standard contributors.
   - If using branch protection rules: do not grant direct push/merge bypass rights to contributor roles.
   - If using rulesets: leave bypass actor list empty for contributors.
8. Save changes.

## Verify Check Names Before Saving

Because required checks are matched by exact name, verify names from a recent pull request run:

1. Open any recent PR.
2. Open the **Checks** tab.
3. Confirm job names are exactly `lint`, `typecheck`, `test`, `build`.
4. If names differ, update branch protection to match the actual check names.

## Optional: Apply via GitHub API

Use this payload with `PUT /repos/{owner}/{repo}/branches/main/protection`:

```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["lint", "typecheck", "test", "build"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_conversation_resolution": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_linear_history": false,
  "lock_branch": false,
  "allow_fork_syncing": true
}
```

Example with GitHub CLI:

```bash
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  /repos/<owner>/<repo>/branches/main/protection \
  --input .github/rulesets/main-v1-required-checks-branch-protection.json
```

## What Cannot Be Applied from Local Repo Alone

Branch protection and rulesets are repository settings stored in GitHub, not in git-tracked source files. This repository includes templates and exact instructions, but a maintainer must apply them in GitHub settings or via the API.
