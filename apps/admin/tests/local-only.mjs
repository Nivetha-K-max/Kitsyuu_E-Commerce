/* The admin test run may only ever use the LOCAL test database (2026-10-08), the same rule the store runner applies.
   The three URLs written by database/scripts/test-db.mjs are checked every time they are read: each must be present, on
   localhost, in the kitsyuu_test database, with the expected role. A missing or different value stops the run: without this
   check a missing ADMIN_DATABASE_URL would let the test server fall back to apps/admin/.env.local. Values are never printed. */
const EXPECTED = {ADMIN_DATABASE_URL: 'kitsyuu_admin', WEBSITE_DATABASE_URL: 'kitsyuu_website', KITSYUU_DB_URL: null};

export function assertLocalTestEnv(env) {
  for (const [name, role] of Object.entries(EXPECTED)) {
    const value = env?.[name];
    if (!value) throw new Error(`refusing: ${name} is missing from the test environment (the test server would fall back to a local env file)`);
    let u;
    try { u = new URL(value); } catch { throw new Error(`refusing: ${name} is not a database URL`); }
    if (!['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error(`refusing: ${name} does not point at this machine`);
    if (u.pathname !== '/kitsyuu_test') throw new Error(`refusing: ${name} is not the local test database (kitsyuu_test)`);
    if (role && decodeURIComponent(u.username) !== role) throw new Error(`refusing: ${name} does not use the ${role} role`);
  }
  return env;
}

/** For a browser suite's own database connection: the URL itself when it is the local test database, else an error. A suite
    started by hand with another KITSYUU_DB_URL would otherwise read and write wherever that pointed (2026-10-09). */
export function assertLocalOwnerUrl(value) {
  let u;
  try { u = new URL(value ?? ''); } catch { throw new Error('refusing: KITSYUU_DB_URL is missing or not a database URL'); }
  if (!['localhost', '127.0.0.1'].includes(u.hostname) || u.pathname !== '/kitsyuu_test') throw new Error('refusing: KITSYUU_DB_URL is not the local test database (kitsyuu_test on this machine)');
  return value;
}
