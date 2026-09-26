/* Sets (or rotates) the password of an application database role and writes the app's connection string to its
   git-ignored env file. The password is generated here, never printed, and sent to Postgres only as a SCRAM-SHA-256
   verifier (so the plain password never appears in SQL, server logs or pg_stat_statements).
   Usage (repo root):
     npm run db:app-role -- --role=kitsyuu_admin --out-file=apps/admin/.env.local --var=ADMIN_DATABASE_URL
   (--out-file, not --env-file: Node itself consumes any --env-file= argument.)
   Target: the Supabase database from apps/website/.env.local (with SUPABASE_DB_POOLER_HOST), or KITSYUU_DB_URL when set
   (local test databases). For Supabase the written URL uses the transaction pooler (port 6543, user <role>.<ref>). */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {connect, connectionConfig} from './lib/connection.mjs';

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const role = arg('role'), envFile = arg('out-file'), varName = arg('var');
if (!['kitsyuu_admin', 'kitsyuu_website'].includes(role) || !envFile || !/^[A-Z][A-Z0-9_]*$/.test(varName || '')) {
  console.error('Usage: app-role --role=kitsyuu_admin|kitsyuu_website --out-file=<path> --var=<ENV_VAR_NAME>'); process.exit(1);
}

// RFC 5802 / RFC 7677 SCRAM-SHA-256 verifier, in the format Postgres stores in pg_authid.rolpassword.
function scramVerifier(password, iterations = 4096) {
  const salt = crypto.randomBytes(16);
  const salted = crypto.pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

function upsertEnv(file, key, value) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const i = lines.findIndex(l => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`; else lines.push(`${key}=${value}`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, lines.join('\n').replace(/\n*$/, '\n'), {mode: 0o600});
}

const password = crypto.randomBytes(32).toString('base64url');   // 256 bits; URL-safe, so no escaping in the connection string
const verifier = scramVerifier(password);
const c = await connect();
try {
  const before = (await c.query('select rolcanlogin, rolconnlimit from pg_roles where rolname = $1', [role])).rows[0];
  if (!before) throw new Error(`Role ${role} does not exist. Apply the migrations first.`);
  if (!before.rolcanlogin) throw new Error(`Role ${role} is NOLOGIN. Apply the migration that enables its login first.`);
  await c.query('begin');
  await c.query(`alter role ${role} with password ${c.escapeLiteral(verifier)}`);
  await c.query('commit');
} catch (e) { await c.query('rollback').catch(() => {}); console.error('FAILED:', e.message); process.exit(1); }
finally { await c.end(); }

// Connection string for the app: same host as the target; Supabase uses the transaction pooler (6543).
let url;
if (process.env.KITSYUU_DB_URL) {
  const u = new URL(process.env.KITSYUU_DB_URL);
  url = `postgresql://${role}:${password}@${u.hostname}:${u.port || 5432}${u.pathname}`;
} else {
  const cfg = connectionConfig();
  if (cfg.via !== 'session pooler') throw new Error('Set SUPABASE_DB_POOLER_HOST: apps connect through the Supabase pooler.');
  const ref = cfg.user.split('.')[1];
  url = `postgresql://${role}.${ref}:${password}@${cfg.host}:6543/${cfg.database}`;
}
upsertEnv(envFile, varName, url);
console.log(`Password set for ${role} (SCRAM-SHA-256; not printed). ${varName} written to ${envFile}.`);
