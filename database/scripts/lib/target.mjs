/* Deliberate production access for the database scripts (2026-10-08).
   A script may touch a host that is not this machine only when BOTH are true:
     1. it was started with  --target=production
     2. a person types  PRODUCTION  at the prompt (so it cannot happen from another script, a test runner or CI by accident)
   Local targets (localhost) need neither. The host name is never printed. */
import readline from 'node:readline/promises';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export const isLocalHost = host => LOCAL_HOSTS.has(host);
let confirmed = false;

/** Throws unless `host` is local, or production access was asked for and confirmed. `what` says what is about to be reached. */
export async function requireProductionIntent(host, what) {
  if (isLocalHost(host)) return;
  if (!process.argv.includes('--target=production')) {
    throw new Error(`Refusing: ${what} is not on this machine. Local runs use the local test database only. `
      + 'To run against the hosted project on purpose, load its credentials from a file outside the repository and add --target=production.');
  }
  if (confirmed) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Refusing: production access must be confirmed by a person in an interactive terminal.');
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  const answer = await rl.question(`\nThis will run against the HOSTED (production) project: ${what}.\nType PRODUCTION to continue, anything else to stop: `);
  rl.close();
  if (answer.trim() !== 'PRODUCTION') throw new Error('Not confirmed. Nothing was done.');
  confirmed = true;
}

/** The same check for a URL (Supabase API, storage). */
export async function requireProductionIntentForUrl(url, what) {
  let host = '';
  try { host = new URL(url).hostname; } catch { throw new Error(`${what}: not a valid URL.`); }
  return requireProductionIntent(host, what);
}
