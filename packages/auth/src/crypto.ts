/* Passwords and one-time tokens. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// OWASP Password Storage Cheat Sheet: argon2id, m = 19 MiB, t = 2, p = 1.
// algorithm 2 = Argon2id (the package's Algorithm is a type-only const enum, so the value is written out).
const ARGON2 = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2);
}

/** Constant-work verify. Unknown formats are rejected (legacy bcrypt support arrives with the customer migration in M6). */
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (!stored || !stored.startsWith('$argon2id$')) { await verify(await dummyHash(), password).catch(() => false); return false; }
  try { return await verify(stored, password); } catch { return false; }
}

/** A real argon2id hash of a random value, made once per process. Verifying against it when the account does not
    exist (or has no password yet) costs the same time as a real check, so timing does not reveal which emails exist. */
let dummy: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  return (dummy ??= hash(randomBytes(16).toString('hex'), ARGON2));
}

/** 256-bit random token for cookies and emailed links (43 base64url chars). Only its SHA-256 is stored. */
export function newToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
