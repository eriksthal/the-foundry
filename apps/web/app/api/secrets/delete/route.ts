import { NextResponse } from 'next/server';
import { secrets } from '@the-foundry/db';
import { requireApiUser, unauthorizedJson } from '../../../../lib/auth';

export async function POST(req: Request) {
  const session = await requireApiUser();
  if (!session) return unauthorizedJson();
  let body: { owner?: string; repo?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const { owner, repo } = body;
  if (!owner || !repo) return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  try {
    await secrets.deleteSecret(owner, repo);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({
      error: 'server_error',
      detail: e instanceof Error ? e.message : String(e)
    }, { status: 500 });
  }
}
