"use client";
import { useState } from 'react';

export default function SecretsPage() {
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [envText, setEnvText] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('Uploading...');
    try {
      const res = await fetch('/api/secrets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // When Clerk is not configured, you can provide x-foundry-admin-token header
          // 'x-foundry-admin-token': process.env.NEXT_PUBLIC_FOUNDRY_ADMIN_TOKEN
        },
        body: JSON.stringify({ owner, repo, env: envText }),
      });
      const j = await res.json();
      if (res.ok) setStatus('Uploaded successfully');
      else setStatus(`Error: ${j.error || res.status}`);
    } catch {
      setStatus('Network error');
    }
  }

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-semibold mb-4">Upload Project Secrets</h1>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium">Owner</label>
          <input className="mt-1 w-full" value={owner} onChange={(e) => setOwner(e.target.value)} />
        </div>
        <div>
          <label className="block text-sm font-medium">Repo</label>
          <input className="mt-1 w-full" value={repo} onChange={(e) => setRepo(e.target.value)} />
        </div>
        <div>
          <label className="block text-sm font-medium">.env content</label>
          <textarea rows={10} className="mt-1 w-full font-mono text-sm" value={envText} onChange={(e) => setEnvText(e.target.value)} />
        </div>
        <div>
          <button type="submit" className="px-4 py-2 bg-sky-600 text-white rounded">Upload</button>
        </div>
        {status && <div className="text-sm mt-2">{status}</div>}
      </form>
    </div>
  );
}
