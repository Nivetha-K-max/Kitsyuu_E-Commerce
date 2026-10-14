/* Which LOCAL database the automated tests use (2026-10-14).
   Default: kitsyuu_test and apps/admin/tests/.output/test.env, exactly as before.
   KITSYUU_TEST_DB=kitsyuu_e2e_<name> runs the tests in their OWN throwaway database instead, with their own env file
   (apps/admin/tests/.output/test-kitsyuu_e2e_<name>.env), so the local demo copy (kitsyuu_test, its test.env) is never
   dropped, recreated or rewritten. In that mode test-db.mjs also keeps the app roles' passwords as the demo's test.env
   has them (the roles are shared by every database of the cluster), so the demo keeps working during and after the run.
   Only kitsyuu_test or a kitsyuu_e2e_… name is accepted: the preserved demo (kitsyuu_test_keep) can never be a target. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const DEFAULT_TEST_DB = 'kitsyuu_test';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUTPUT = path.join(REPO, 'apps/admin/tests/.output');

export function testDbName() {
  const name = (process.env.KITSYUU_TEST_DB ?? '').trim() || DEFAULT_TEST_DB;
  if (name !== DEFAULT_TEST_DB && !/^kitsyuu_e2e_[a-z0-9_]{1,40}$/.test(name))
    throw new Error(`refusing: KITSYUU_TEST_DB must be ${DEFAULT_TEST_DB} or kitsyuu_e2e_<letters, digits, _> (got "${name}")`);
  return name;
}
export const isolatedTestDb = () => testDbName() !== DEFAULT_TEST_DB;
/** The env file test-db.mjs writes for the database in use. */
export const testEnvFile = () => path.join(OUTPUT, isolatedTestDb() ? `test-${testDbName()}.env` : 'test.env');
/** The demo copy's env file (never written in isolated mode; read only for the app roles' current passwords). */
export const DEMO_ENV_FILE = path.join(OUTPUT, 'test.env');
