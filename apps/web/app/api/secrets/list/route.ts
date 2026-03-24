import { NextResponse } from 'next/server';
import { prisma } from '@the-foundry/db';
import { requireApiUser, unauthorizedJson } from '../../../../lib/auth';


/**
 * Decision: For security, the API and UI only indicate the presence of a secret for a project.
 * Secret keys (env variable names) are NOT shown or extracted, only a placeholder is returned if a secret exists.
 * This avoids leaking sensitive metadata. If you need to show actual keys, decrypt and parse server-side with Clerk auth.
 *
 * Returns: { present: boolean } — never returns keys or values.
 */

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
    const secret = await prisma.secret.findUnique({ where: { owner_repo: { owner, repo } } });
    // For security, do not return actual keys. Only indicate presence.
    return NextResponse.json({ present: !!secret });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'server_error' }, { status: 500 });
  }
}
