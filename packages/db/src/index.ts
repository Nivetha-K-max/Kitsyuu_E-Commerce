/* Server-only Postgres access for the KITSYUU apps (Kysely over node-postgres).
   Each app connects with its own database role (kitsyuu_admin / kitsyuu_website) through the Supabase pooler; the
   connection string comes from the app's environment and is never sent to the browser. */
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.ts';

export type * from './schema.ts';
export { sql };
export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;
/** Anything that can run a query: the pool or an open transaction. */
export type Queryable = Db | Tx;

if (typeof window !== 'undefined') throw new Error('@kitsyuu/db is server-only and must never be imported by browser code');

// Postgres returns bigint (int8) as a string by default; counts and ids used here fit safely in a JS number.
pg.types.setTypeParser(20, (v: string) => Number(v));

export interface DbOptions {
  connectionString: string;
  /** Pool size per server instance (serverless functions should keep this small). */
  max?: number;
}

export function createDb({ connectionString, max = 5 }: DbOptions): Db {
  const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(connectionString);
  const pool = new pg.Pool({
    connectionString,
    max,
    // Supabase requires TLS. Local test databases do not use it.
    ssl: local ? undefined : { rejectUnauthorized: false },
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export { recordAudit, type AuditEntry } from './audit.ts';
