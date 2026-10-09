/* Where the store reads its public catalogue and content from (2026-10-08).

     (unset)   the hosted project's public API, exactly as before: production, and the only source in a deployment.
     database  LOCAL and TEST only: the same rows read from this machine's PostgreSQL through the store's own database
               role (lib/supabase/local-source.ts), with product pictures served from the repository's own files. A local
               store, a test run or a load run then never contacts the hosted project.

   The two never mix. In database mode a configured hosted public URL is an error, not a fallback, and database mode is
   refused in a deployment. Read on the server at run time; nothing here reaches the browser. */
import { isDeployed } from './db-guard';

export const LOCAL_IMAGE_PREFIX = '/storage/v1/object/public/product-images';

export function catalogueSource(env: Record<string, string | undefined> = process.env): 'api' | 'database' {
  const v = env.CATALOGUE_SOURCE;
  if (!v) return 'api';
  if (v !== 'database') throw new Error('CATALOGUE_SOURCE must be "database" or left unset.');
  if (isDeployed(env)) throw new Error('CATALOGUE_SOURCE=database is for local development and tests only; it is refused in a deployment.');
  // process.env.NEXT_PUBLIC_* is fixed when the app is built, so this also catches a build made for the hosted API.
  if (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL)
    throw new Error('CATALOGUE_SOURCE=database, but a hosted public API URL is configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL). '
      + 'Refusing to mix the two: build and start the local store without those variables (see apps/website/tests/build-local.mjs).');
  return 'database';
}

/** The address of a product picture in database mode: served by this app from the repository's own image files. */
export const localImageUrl = (storagePath: string) => `${LOCAL_IMAGE_PREFIX}/${storagePath.split('/').map(encodeURIComponent).join('/')}`;
