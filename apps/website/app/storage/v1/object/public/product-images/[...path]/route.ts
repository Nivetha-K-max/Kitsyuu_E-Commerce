import fs from 'node:fs/promises';
import path from 'node:path';
import { catalogueSource } from '@/lib/catalogue-source';

/* Local development and tests only (CATALOGUE_SOURCE=database): product pictures from the repository's own files
   (dist/store/images/products/<id>.webp, the originals the hosted bucket was filled from), at the same path the hosted
   bucket uses, so nothing that shows a picture needs to know the difference. Read-only. With the hosted API as the source
   (production) this route does not exist: 404. */
export const dynamic = 'force-dynamic';
const ROOT = path.resolve(process.cwd(), '../../dist/store/images/products');

export async function GET(_: Request, { params }: { params: Promise<{ path: string[] }> }) {
  let local = false;
  try { local = catalogueSource() === 'database'; } catch { /* misconfigured: not served */ }
  const rel = (await params).path.join('/');
  // Exactly the stored form: products/<product id>.webp. Nothing else is read from disk.
  const m = /^products\/([a-z0-9][a-z0-9-]{0,80})\.webp$/.exec(rel);
  if (!local || !m) return new Response('Not found', { status: 404 });
  const full = path.join(ROOT, `${m[1]}.webp`);
  if (!full.startsWith(ROOT + path.sep)) return new Response('Not found', { status: 404 });
  try {
    const body = await fs.readFile(full);
    return new Response(new Uint8Array(body), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
