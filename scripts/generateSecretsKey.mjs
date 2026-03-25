#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
const key = crypto.randomBytes(32).toString('base64');
const envVar = `FOUNDRY_SECRETS_KEY=${key}`;

if (!fs.existsSync(envPath)) {
  fs.writeFileSync(envPath, envVar + '\n', 'utf8');
  console.log(`Created ${envPath} with FOUNDRY_SECRETS_KEY`);
} else {
  const content = fs.readFileSync(envPath, 'utf8');
  if (/^FOUNDRY_SECRETS_KEY=.*/m.test(content)) {
    const updated = content.replace(/^FOUNDRY_SECRETS_KEY=.*/m, envVar);
    fs.writeFileSync(envPath, updated, 'utf8');
    console.log('Updated FOUNDRY_SECRETS_KEY in .env');
  } else {
    fs.appendFileSync(envPath, (content.endsWith('\n') ? '' : '\n') + envVar + '\n', 'utf8');
    console.log('Appended FOUNDRY_SECRETS_KEY to .env');
  }
}
