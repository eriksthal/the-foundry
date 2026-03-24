import { NextResponse } from 'next/server';
import { prisma, secrets } from '@the-foundry/db';
import { requireApiUser, unauthorizedJson } from '../../../../../lib/auth';
import { loadRootEnv } from '../../../../../lib/load-root-env';

loadRootEnv();

// Helper to map projectId to { owner, repo }
async function getOwnerRepo(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error('Project not found');
  // repoUrl is expected to be in the form 'https://github.com/owner/repo' or 'owner/repo'
  const repoUrl = project.repoUrl;
  if (!repoUrl) throw new Error('Project missing repoUrl');
  if (repoUrl.startsWith('http')) {
    const match = repoUrl.match(/github.com[/:]([^/]+)\/([^/]+)/);
    if (!match) throw new Error('Invalid repoUrl');
    const owner = match[1];
    const repo = match[2];
    if (!owner || !repo) throw new Error('Invalid repoUrl');
    return { owner, repo: repo.replace(/.git$/, '') };
  }
  const [owner, repo] = repoUrl.split('/');
  if (!owner || !repo) throw new Error('Invalid repoUrl');
  return { owner, repo };
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const session = await requireApiUser();
  if (!session) return unauthorizedJson();
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = await getOwnerRepo(params.id));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
  // Only return metadata, never secret values
  const secret = await prisma.secret.findUnique({ where: { owner_repo: { owner, repo } } });
  if (!secret) return NextResponse.json({ secrets: [] });
  return NextResponse.json({ secrets: [{ owner, repo, createdAt: secret.createdAt, updatedAt: secret.updatedAt }] });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await requireApiUser();
  if (!session) return unauthorizedJson();
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = await getOwnerRepo(params.id));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
  let body: { env?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const { env } = body;
  if (!env) return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  try {
    await secrets.upsertSecret(owner, repo, env);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const session = await requireApiUser();
  if (!session) return unauthorizedJson();
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = await getOwnerRepo(params.id));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
  try {
    await secrets.deleteSecret(owner, repo);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
