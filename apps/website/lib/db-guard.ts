/* Environment safety (2026-10-08). A process that is not a production deployment must never reach the hosted database:
   a local dev server, a local production build, a test runner or a script that inherits a stray environment file would
   otherwise read and write real data. Outside a deployment the database URL must point at this machine; anything else is
   refused before a connection is attempted.
   "A deployment" is the hosting platform's own marker (VERCEL=1, set by Vercel at build and at run time) or, on any other
   host, the explicit KITSYUU_DEPLOYMENT=production. Nothing in a local env file should set either. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isDeployed(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL === '1' || env.KITSYUU_DEPLOYMENT === 'production';
}

/** The URL itself when it may be used; otherwise an error that names the variable (never its value). */
export function guardedDatabaseUrl(name: string, url: string, env: Record<string, string | undefined> = process.env): string {
  if (isDeployed(env)) return url;
  let host = '';
  try { host = new URL(url).hostname; } catch { throw new Error(`${name} is not a valid database URL.`); }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`${name} points at a database that is not on this machine, and this is not a production deployment. `
      + 'Refusing to connect. Use the local test database for development and tests (see database/README.md).');
  }
  return url;
}
