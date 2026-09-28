/* M18: staff two-factor sign-in with an authenticator app (TOTP, RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), using
   only node:crypto. The shared secret is stored encrypted (AES-256-GCM) with the key in MFA_ENCRYPTION_KEY (32 bytes,
   base64). Without that key two-factor is unavailable, never stored unprotected. Recovery codes are one-time and stored
   only as SHA-256 hashes. */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashToken } from './crypto.ts';

const STEP = 30, DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** The 6-digit code for a secret at a given 30-second step. */
export function totpAt(secret: Buffer, step: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}
export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP);

/** The matching step (±1 step for clock drift), or null. Only steps after lastUsedStep are accepted (no replay). */
export function verifyTotp(secret: Buffer, code: string, lastUsedStep: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const s = currentStep(now);
  for (const step of [s - 1, s, s + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    const a = Buffer.from(totpAt(secret, step)), b = Buffer.from(code);
    if (timingSafeEqual(a, b)) return step;
  }
  return null;
}

/** The encryption key, or null when two-factor is not configured on this deployment. */
export function mfaKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.MFA_ENCRYPTION_KEY;
  if (!raw) return null;
  const k = Buffer.from(raw, 'base64');
  return k.length === 32 ? k : null;
}
export function encryptSecret(key: Buffer, secret: Buffer): Buffer {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(secret), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);                // 12-byte IV · 16-byte tag · ciphertext
}
export function decryptSecret(key: Buffer, blob: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

export const newMfaSecret = () => randomBytes(20);
/** otpauth:// link that authenticator apps understand (also shown as the plain key for manual entry). */
export const otpauthUri = (secret: Buffer, account: string, issuer = 'KITSYUU Admin') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/** Ten one-time recovery codes (xxxxx-xxxxx) and their hashes. The codes are shown once; only hashes are stored. */
export function newRecoveryCodes(n = 10): { codes: string[]; hashes: Buffer[] } {
  const codes = Array.from({ length: n }, () => { const s = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase(); return `${s.slice(0, 5)}-${s.slice(5)}`; });
  return { codes, hashes: codes.map(hashRecoveryCode) };
}
export const hashRecoveryCode = (code: string) => hashToken(code.trim().toLowerCase().replace(/\s/g, ''));
export const looksLikeRecoveryCode = (code: string) => /^[a-z2-7]{5}-[a-z2-7]{5}$/i.test(code.trim());
