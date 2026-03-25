#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');

// Load .env manually so we can read the old key
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

const prisma = new PrismaClient();

function getKeyFromBase64(b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 32) throw new Error('Key must be 32 bytes (base64-encoded)');
  return buf;
}

function decrypt(blobBase64, keyBuf) {
  const buf = Buffer.from(blobBase64, 'base64');
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const ciphertext = buf.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function encrypt(plaintext, keyBuf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

async function main() {
  const oldKeyB64 = process.env.FOUNDRY_SECRETS_KEY;
  if (!oldKeyB64) {
    console.error('FOUNDRY_SECRETS_KEY not found in environment or .env file.');
    process.exit(1);
  }

  const oldKey = getKeyFromBase64(oldKeyB64);
  const newKeyB64 = crypto.randomBytes(32).toString('base64');
  const newKey = getKeyFromBase64(newKeyB64);

  // Fetch all secrets
  const secrets = await prisma.secret.findMany();
  console.log(`Found ${secrets.length} secret(s) to re-encrypt.`);

  // Decrypt with old key, re-encrypt with new key
  let failures = 0;
  for (const secret of secrets) {
    try {
      const plaintext = decrypt(secret.envBlob, oldKey);
      const newBlob = encrypt(plaintext, newKey);
      await prisma.secret.update({
        where: { id: secret.id },
        data: { envBlob: newBlob },
      });
      console.log(`  ✓ ${secret.owner}/${secret.repo}`);
    } catch (e) {
      failures++;
      console.error(`  ✗ ${secret.owner}/${secret.repo}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} secret(s) failed to re-encrypt. Old key was NOT replaced.`);
    process.exit(2);
  }

  // Write new key to .env
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    if (/^FOUNDRY_SECRETS_KEY=.*/m.test(content)) {
      fs.writeFileSync(envPath, content.replace(/^FOUNDRY_SECRETS_KEY=.*/m, `FOUNDRY_SECRETS_KEY=${newKeyB64}`), 'utf8');
    } else {
      fs.appendFileSync(envPath, (content.endsWith('\n') ? '' : '\n') + `FOUNDRY_SECRETS_KEY=${newKeyB64}\n`, 'utf8');
    }
  } else {
    fs.writeFileSync(envPath, `FOUNDRY_SECRETS_KEY=${newKeyB64}\n`, 'utf8');
  }

  console.log(`\nKey rotated successfully.`);
  console.log(`  Secrets re-encrypted: ${secrets.length}`);
  console.log(`  New key written to .env`);
}

main()
  .catch((e) => {
    console.error('Fatal:', e instanceof Error ? e.message : String(e));
    process.exit(3);
  })
  .finally(() => prisma.$disconnect());
