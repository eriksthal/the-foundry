#!/usr/bin/env node
import fs from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';

const prisma = new PrismaClient();

function getKey() {
  const b64 = process.env.FOUNDRY_SECRETS_KEY;
  if (!b64) {
    console.error('FOUNDRY_SECRETS_KEY not set in environment');
    process.exit(4);
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 32) {
    console.error('FOUNDRY_SECRETS_KEY must be 32 bytes (base64)');
    process.exit(5);
  }
  return buf;
}

function encryptEnv(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function usage() {
  console.log('Usage: node scripts/addSecret.mjs --owner <owner> --repo <repo> --file <path-to-env-file>');
  process.exit(1);
}

const argv = process.argv.slice(2);
let owner, repo, file;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--owner') owner = argv[++i];
  else if (a === '--repo') repo = argv[++i];
  else if (a === '--file') file = argv[++i];
}

if (!owner || !repo || !file) usage();

const path = resolve(process.cwd(), file);
if (!fs.existsSync(path)) {
  console.error('File not found:', path);
  process.exit(2);
}

const content = fs.readFileSync(path, 'utf8');

(async () => {
  try {
    const envBlob = encryptEnv(content);
    await prisma.secret.upsert({
      where: { owner_repo: { owner, repo } },
      update: { envBlob },
      create: { owner, repo, envBlob },
    });
    console.log('Secret upserted for', owner, repo);
    process.exit(0);
  } catch (e) {
    console.error('Failed to upsert secret:', e instanceof Error ? e.message : String(e));
    process.exit(3);
  } finally {
    await prisma.$disconnect();
  }
})();
