"use client";
import { useEffect, useState } from "react";

type ProjectSecretsProps = {
  project: {
    repoUrl: string;
  };
};

function parseOwnerRepo(repoUrl: string) {
  const match = repoUrl.match(/github.com\/(.+?)\/(.+?)(?:$|\.git)/);
  if (!match) {
    return { owner: "", repo: "" };
  }

  const owner = match[1] ?? "";
  const repo = match[2]?.replace(/\.git$/, "") ?? "";

  return { owner, repo };
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function SecretsSection({ project }: ProjectSecretsProps) {
  const [secretPresent, setSecretPresent] = useState<boolean>(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [envText, setEnvText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  const { owner, repo } = parseOwnerRepo(project.repoUrl);

  useEffect(() => {
    async function fetchSecrets() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/secrets/list", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ owner, repo }),
        });
        const j = await res.json();
        if (!res.ok) {
          setError(j.error ? `Error: ${j.error}` : "Failed to fetch secrets");
        } else {
          setSecretPresent(!!j.present);
        }
      } catch (error) {
        setError(getErrorMessage(error, "Failed to load secrets"));
      } finally {
        setLoading(false);
      }
    }
    if (owner && repo) fetchSecrets();
  }, [owner, repo, refresh]);

  async function handleAddSecret(e: React.FormEvent) {
    e.preventDefault();
    setStatus("Uploading...");
    setError(null);
    try {
      const res = await fetch("/api/secrets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ owner, repo, env: envText }),
      });
      const j = await res.json();
      if (res.ok) {
        setStatus("Secret uploaded");
        setEnvText("");
        setRefresh((r) => r + 1);
      } else {
        setStatus(null);
        setError(j.error ? `Error: ${j.error}` : "Failed to upload secret");
      }
    } catch (error) {
      setStatus(null);
      setError(getErrorMessage(error, "Network error"));
    }
  }

  async function handleDeleteSecret() {
    setStatus("Deleting...");
    setError(null);
    try {
      const res = await fetch("/api/secrets/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ owner, repo }),
      });
      const j = await res.json();
      if (res.ok) {
        setStatus("Secret deleted");
        setRefresh((r) => r + 1);
      } else {
        setStatus(null);
        setError(j.error ? `Error: ${j.error}` : "Failed to delete secret");
      }
    } catch (error) {
      setStatus(null);
      setError(getErrorMessage(error, "Network error"));
    }
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5 mb-8">
      <h2 className="mb-4 font-semibold">Project Secrets</h2>
      <div className="mb-2 text-xs text-zinc-400">
        Secrets are stored encrypted. For security, only the presence of a secret is shown. Secret keys and values are never displayed after upload.
      </div>
      {loading ? (
        <div className="text-sm text-zinc-500">Loading secrets...</div>
      ) : error ? (
        <div className="text-sm text-red-500">{error}</div>
      ) : (
        <>
          <div className="mb-2">
            <div className="font-mono text-xs text-zinc-300">
              {secretPresent ? "Secret(s) present" : "No secrets set for this project."}
            </div>
          </div>
          {secretPresent && (
            <button
              className="rounded bg-red-700 px-3 py-1 text-xs hover:bg-red-600 mb-4"
              onClick={handleDeleteSecret}
            >
              Delete Secret
            </button>
          )}
        </>
      )}
      <form onSubmit={handleAddSecret} className="space-y-3 mt-4">
        <textarea
          name="env"
          required
          rows={4}
          placeholder="Paste .env content (KEY=VALUE)"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-mono placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
        />
        <button
          type="submit"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-500"
        >
          Add/Update Secret
        </button>
        {status && <div className="text-xs text-zinc-400 mt-1">{status}</div>}
      </form>
    </div>
  );
}
