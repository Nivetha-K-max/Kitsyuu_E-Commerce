/* Postgres connection for the database scripts. Server-side only; nothing here is ever bundled into an app.
   Reads SUPABASE_DB_URL (direct connection string). The direct host is IPv6-only, so on IPv4 networks set
   SUPABASE_DB_POOLER_HOST (e.g. aws-0-<region>.pooler.supabase.com, shown under Supabase → Connect → Session pooler):
   the same credentials are then sent to the session pooler (port 5432, user postgres.<project-ref>).
   No host, user or password is hard-coded here. */
import pg from 'pg';

export function connectionConfig() {
  const raw = process.env.SUPABASE_DB_URL;
  if (!raw || /REPLACE_WITH|\[YOUR-PASSWORD\]/.test(raw)) throw new Error('SUPABASE_DB_URL is not set in apps/website/.env.local');
  const url = new URL(raw);
  const base = {database: decodeURIComponent(url.pathname.slice(1)) || 'postgres', password: decodeURIComponent(url.password),
    ssl: {rejectUnauthorized: false}, connectionTimeoutMillis: 15000};
  const pooler = process.env.SUPABASE_DB_POOLER_HOST;
  if (!pooler) return {...base, host: url.hostname, port: Number(url.port) || 5432, user: decodeURIComponent(url.username), via: 'direct'};
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || '').hostname.split('.')[0];
  if (!ref) throw new Error('NEXT_PUBLIC_SUPABASE_URL is needed to build the pooler user name');
  const user = decodeURIComponent(url.username).includes('.') ? decodeURIComponent(url.username) : `${decodeURIComponent(url.username)}.${ref}`;
  return {...base, host: pooler, port: Number(process.env.SUPABASE_DB_POOLER_PORT) || 5432, user, via: 'session pooler'};
}

export async function connect() {
  const {via, ...cfg} = connectionConfig();
  const client = new pg.Client(cfg);
  try { await client.connect(); }
  catch (e) {
    const tip = ['ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(e.code) && via === 'direct'
      ? ' Tip: set SUPABASE_DB_POOLER_HOST to the Session pooler host; the direct host is IPv6-only.' : '';
    throw new Error(`Could not connect to the database via ${via} (${e.code || e.message}).${tip}`);
  }
  return client;
}
