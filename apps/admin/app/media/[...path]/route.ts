import fs from 'node:fs/promises';
import path from 'node:path';

/* Development/test only: serves images written by the LOCAL storage driver (STORAGE_DRIVER=local), so local uploads
   never touch the live bucket. Images not stored locally (the existing catalogue images) redirect to the public bucket.
   With any other driver this route does not exist (404). */
export async function GET(_: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (process.env.STORAGE_DRIVER !== 'local' || !process.env.LOCAL_STORAGE_DIR) return new Response('Not found', { status: 404 });
  const parts = (await params).path;
  const rel = parts.join('/');
  if (!/^[a-z0-9][a-z0-9/_.-]{0,200}$/.test(rel) || rel.includes('..')) return new Response('Not found', { status: 404 });
  const root = path.resolve(process.env.LOCAL_STORAGE_DIR);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
  try {
    const body = await fs.readFile(full);
    return new Response(new Uint8Array(body), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' } });
  } catch {
    const base = process.env.PRODUCT_IMAGE_BASE_URL;
    return base ? Response.redirect(`${base.replace(/\/+$/, '')}/${parts.map(encodeURIComponent).join('/')}`, 302) : new Response('Not found', { status: 404 });
  }
}
