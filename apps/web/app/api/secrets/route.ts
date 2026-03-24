import { NextResponse } from 'next/server';

import { secrets } from '@the-foundry/db';
import { requireApiUser, unauthorizedJson } from '../../../lib/auth';
import { loadRootEnv } from '../../../lib/load-root-env';

loadRootEnv();


export async function POST(req: Request) {
  const session = await requireApiUser();

  if (!session) return unauthorizedJson();

  let body: { owner?: string; repo?: string; env?: string } = {};
  try {
    body = await req.json();
  } catch (e) {
    return NextResponse.json({ error: 'invalid_json', detail: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }

  const { owner, repo, env } = body;
  if (!owner || !repo || !env) return NextResponse.json({ error: 'missing_fields', detail: 'owner, repo, and env are required' }, { status: 400 });

  try {
    // upsert into secrets (this encrypts using FOUNDRY_SECRETS_KEY)
    await secrets.upsertSecret(owner, repo, env);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[secrets.api] failed to upsert secret', e instanceof Error ? e.message : String(e));
    return NextResponse.json({ error: e instanceof Error ? e.message : 'server_error' }, { status: 500 });
  }
}
