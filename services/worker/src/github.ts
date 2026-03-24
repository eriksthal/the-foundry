import { execSync } from "node:child_process";
import { Buffer } from "node:buffer";
import type { Project, Task } from "@the-foundry/db";

type GitHubRepoRef = {
  owner: string;
  repo: string;
};

export type PullRequestInfo = {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  title: string;
};

export function parseGitHubRepoUrl(url: string): GitHubRepoRef | null {
  if (!url) return null;

  const sshMatch = url.match(/^[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1]!, repo: sshMatch[2]! };

  const httpsMatch = url.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };

  return null;
}

export function buildTaskUrl(taskId: string): string | null {
  const baseUrl = process.env.FOUNDRY_APP_URL?.trim() || "http://localhost:3000";

  try {
    return new URL(`/tasks/${taskId}`, baseUrl).toString();
  } catch {
    return null;
  }
}

export function getGitStatusSummary(workDir: string): {
  hasUncommittedChanges: boolean;
  branchExistsOnRemote: boolean;
  commitsAheadOfBase: number;
} {
  const porcelain = runGit(workDir, ["status", "--porcelain"]);
  const hasUncommittedChanges = Boolean(porcelain.trim());

  let branchExistsOnRemote = false;
  try {
    runGit(workDir, ["ls-remote", "--exit-code", "--heads", "origin", currentBranch(workDir)]);
    branchExistsOnRemote = true;
  } catch {
    branchExistsOnRemote = false;
  }

  let commitsAheadOfBase = 0;
  try {
    const baseRef = `origin/${defaultBaseBranch(workDir)}`;
    const current = currentBranch(workDir);
    const out = runGit(workDir, ["rev-list", "--count", `${baseRef}..${current}`]);
    commitsAheadOfBase = Number(out.trim()) || 0;
  } catch {
    commitsAheadOfBase = 0;
  }

  return {
    hasUncommittedChanges,
    branchExistsOnRemote,
    commitsAheadOfBase,
  };
}

export function ensureCommittedChanges(workDir: string, taskTitle: string): boolean {
  const status = runGit(workDir, ["status", "--porcelain"]);
  if (!status.trim()) return false;

  ensureGitIdentity(workDir);
  runGit(workDir, ["add", "-A"]);
  runGit(workDir, ["commit", "-m", buildCommitMessage(taskTitle)]);
  return true;
}

export function pushBranchToOrigin(workDir: string, branchName: string, githubToken: string): void {
  const authHeader = Buffer.from(`x-access-token:${githubToken}`).toString("base64");
  runGit(workDir, [
    "-c",
    `http.extraheader=AUTHORIZATION: basic ${authHeader}`,
    "push",
    "--set-upstream",
    "origin",
    branchName,
  ]);
}

export async function findOrCreatePullRequest(params: {
  task: Task;
  project: Project;
  branchName: string;
  reportedPrUrl?: string;
}): Promise<PullRequestInfo | null> {
  const token = process.env.GITHUB_TOKEN?.trim();
  const repoRef = parseGitHubRepoUrl(params.project.repoUrl);

  if (!token || !repoRef) return null;

  const existing = await findPullRequestByHead({
    repo: repoRef,
    branchName: params.branchName,
    token,
  });
  if (existing) return existing;

  return createPullRequest({
    repo: repoRef,
    token,
    title: params.task.title,
    branchName: params.branchName,
    baseBranch: params.project.defaultBranch,
    body: buildPullRequestBody(params.task, params.project, params.reportedPrUrl),
  });
}

async function findPullRequestByHead(params: {
  repo: GitHubRepoRef;
  branchName: string;
  token: string;
}): Promise<PullRequestInfo | null> {
  const url = `https://api.github.com/repos/${params.repo.owner}/${params.repo.repo}/pulls?head=${encodeURIComponent(`${params.repo.owner}:${params.branchName}`)}&state=all`;
  const response = await githubRequest(url, params.token);
  if (!response.ok) return null;

  const pulls = (await response.json()) as Array<Record<string, unknown>>;
  const first = pulls[0];
  return first ? toPullRequestInfo(first) : null;
}

async function createPullRequest(params: {
  repo: GitHubRepoRef;
  token: string;
  title: string;
  branchName: string;
  baseBranch: string;
  body: string;
}): Promise<PullRequestInfo | null> {
  const response = await githubRequest(
    `https://api.github.com/repos/${params.repo.owner}/${params.repo.repo}/pulls`,
    params.token,
    {
      method: "POST",
      body: JSON.stringify({
        title: params.title,
        head: params.branchName,
        base: params.baseBranch,
        body: params.body,
      }),
    },
  );

  if (!response.ok) return null;

  const payload = (await response.json()) as Record<string, unknown>;
  return toPullRequestInfo(payload);
}

function buildPullRequestBody(task: Task, project: Project, reportedPrUrl?: string): string {
  const taskUrl = buildTaskUrl(task.id);
  const sections = [
    "## Summary",
    task.description.trim(),
    "",
    "## Foundry Metadata",
    `- Task ID: ${task.id}`,
    `- Project ID: ${project.id}`,
  ];

  if (taskUrl) sections.push(`- Foundry Task: ${taskUrl}`);
  if (reportedPrUrl) sections.push(`- Agent-reported PR URL: ${reportedPrUrl}`);

  return sections.join("\n");
}

function buildCommitMessage(taskTitle: string): string {
  const normalized = taskTitle.trim().replace(/\s+/g, " ");
  return normalized || "Apply Foundry task changes";
}

function ensureGitIdentity(workDir: string): void {
  const hasName = runGit(workDir, ["config", "--get", "user.name"], { allowFailure: true });
  const hasEmail = runGit(workDir, ["config", "--get", "user.email"], { allowFailure: true });

  if (!hasName.trim()) runGit(workDir, ["config", "user.name", "Foundry Bot"]);
  if (!hasEmail.trim()) {
    runGit(workDir, ["config", "user.email", "foundry-bot@users.noreply.github.com"]);
  }
}

function currentBranch(workDir: string): string {
  return runGit(workDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

function defaultBaseBranch(workDir: string): string {
  const ref = runGit(workDir, ["symbolic-ref", "refs/remotes/origin/HEAD"], {
    allowFailure: true,
  }).trim();
  return ref.split("/").pop() || "main";
}

function runGit(
  workDir: string,
  args: string[],
  options?: { allowFailure?: boolean },
): string {
  try {
    return execSync(`git ${args.map(shellEscape).join(" ")}`, {
      cwd: workDir,
      encoding: "utf8",
      stdio: "pipe",
      env: process.env,
    });
  } catch (error) {
    if (options?.allowFailure) return "";
    throw error;
  }
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function githubRequest(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "the-foundry",
      ...(init?.headers ?? {}),
    },
  });
}

function toPullRequestInfo(payload: Record<string, unknown>): PullRequestInfo | null {
  const number = typeof payload.number === "number" ? payload.number : null;
  const url = typeof payload.html_url === "string" ? payload.html_url : null;
  const state = payload.state === "closed" ? "closed" : payload.state === "open" ? "open" : null;
  const merged = payload.merged === true;
  const title = typeof payload.title === "string" ? payload.title : "";

  if (!number || !url || !state) return null;

  return { number, url, state, merged, title };
}
