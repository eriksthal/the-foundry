import { loadRootEnv } from "./load-root-env";

loadRootEnv();

export type PullRequestState = {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
};

export async function getPullRequestState(prUrl: string): Promise<PullRequestState | null> {
  const token = process.env.GITHUB_TOKEN?.trim();
  const ref = parsePullRequestUrl(prUrl);

  if (!token || !ref) return null;

  const response = await fetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "the-foundry-web",
      },
      cache: "no-store",
    },
  );

  if (!response.ok) return null;

  const payload = (await response.json()) as Record<string, unknown>;
  if (
    typeof payload.number !== "number" ||
    typeof payload.html_url !== "string" ||
    typeof payload.title !== "string" ||
    (payload.state !== "open" && payload.state !== "closed")
  ) {
    return null;
  }

  return {
    number: payload.number,
    title: payload.title,
    url: payload.html_url,
    state: payload.state,
    merged: payload.merged === true,
    mergedAt: typeof payload.merged_at === "string" ? payload.merged_at : null,
  };
}

function parsePullRequestUrl(url: string): { owner: string; repo: string; number: number } | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (!match) return null;

    return {
      owner: match[1]!,
      repo: match[2]!,
      number: Number(match[3]!),
    };
  } catch {
    return null;
  }
}

// ─── GitHub Models Catalog ──────────────────────────────

export type GitHubModel = {
  id: string;
  label: string;
  description: string;
  publisher: string;
};

let cachedModels: GitHubModel[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getGitHubModels(): Promise<GitHubModel[] | null> {
  const token = process.env.COPILOT_GITHUB_TOKEN?.trim();
  if (!token) return null;

  if (cachedModels && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  try {
    const response = await fetch("https://models.github.ai/catalog/models", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "the-foundry-web",
      },
      cache: "no-store",
    });

    if (!response.ok) return null;

    const payload = (await response.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(payload)) return null;

    const models: GitHubModel[] = payload
      .filter((m) => {
        const capabilities = m.capabilities as string[] | undefined;
        return Array.isArray(capabilities) && capabilities.includes("agents");
      })
      .map((m) => ({
        id: String(m.id ?? "").replace(/^[^/]+\//, ""),
        label: String(m.name ?? ""),
        description: String(m.summary ?? "").slice(0, 80),
        publisher: String(m.publisher ?? ""),
      }))
      .filter((m) => m.id && m.label);

    cachedModels = models;
    cacheTimestamp = Date.now();
    return models;
  } catch {
    return null;
  }
}
