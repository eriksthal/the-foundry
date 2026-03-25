/**
 * IMPORTANT: FOUNDRY_SECRETS_KEY must be set in the root .env file.
 *
 * - This key is required for all encryption/decryption operations in this module.
 * - It must be a 32-byte, base64-encoded string.
 * - In local development, ensure you load the root .env (e.g., with dotenv.config())
 *   in the worker or API process entrypoint before importing or using this module.
 * - The worker and all API routes that use secrets must have access to this env var.
 */
import crypto from 'node:crypto';
import { PrismaClient } from "@prisma/client";
import { prisma } from "./index.ts";


// NOTE: FOUNDRY_SECRETS_KEY must be set in the environment. In local dev, ensure dotenv.config() is called in the API route or entrypoint before using this module.
const KEY_ENV = 'FOUNDRY_SECRETS_KEY';

function getKey(): Buffer {
  const b64 = process.env[KEY_ENV];
  if (!b64) throw new Error(`${KEY_ENV} is not set`);
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 32) throw new Error(`${KEY_ENV} must be 32 bytes (base64-encoded)`);
  return buf;
}

export function encryptEnv(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptEnv(blobBase64: string): string {
  const key = getKey();
  const buf = Buffer.from(blobBase64, 'base64');
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const ciphertext = buf.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return out.toString('utf8');
}

export async function upsertSecret(owner: string, repo: string, plaintextEnv: string, keyVersion?: string) {
  const envBlob = encryptEnv(plaintextEnv);
  const db = prisma as PrismaClient;
  return db.secret.upsert({
    where: { owner_repo: { owner, repo } },
    update: { envBlob, keyVersion },
    create: { owner, repo, envBlob, keyVersion },
  });
}

export async function getDecryptedSecret(owner: string, repo: string): Promise<string | null> {
  const db = prisma as PrismaClient;
  const row = await db.secret.findUnique({ where: { owner_repo: { owner, repo } } });
  if (!row) return null;
  try {
    return decryptEnv(row.envBlob);
  } catch (e) {
    throw new Error('Failed to decrypt secret');
  }
}


/**
 * Deletes all secrets for a given owner/repo.
 *
 * Presence-only policy: This helper is used to remove secrets, but the API/UI never exposes secret keys or values—only whether a secret exists.
 * This is a security measure to prevent leaking metadata about secret names or values.
 */
export async function deleteSecret(owner: string, repo: string) {
  const db = prisma as PrismaClient;
  return db.secret.deleteMany({ where: { owner, repo } });
}

export default {
  encryptEnv,
  decryptEnv,
  upsertSecret,
  getDecryptedSecret,
  deleteSecret,
};
