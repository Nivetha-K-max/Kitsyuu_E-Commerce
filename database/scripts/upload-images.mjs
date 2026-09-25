/* Uploads the 22 catalogue images to the product-images bucket as products/<id>.webp.
   Source files are READ ONLY: dist/store/images/products/<id>.webp (the originals are never modified).
   Server-side script: uses SUPABASE_SERVICE_ROLE_KEY from apps/website/.env.local, which never goes to the browser.
   Usage (repo root): npm run db:upload-images */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createClient} from '@supabase/supabase-js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key} = process.env;
if (!url || !key || /REPLACE_WITH/.test(key)) { console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(path.join(REPO, 'apps/website/data/products.json'), 'utf8'));
const SRC = path.join(REPO, 'dist/store/images/products');
const supabase = createClient(url, key, {auth: {persistSession: false, autoRefreshToken: false}});
const md5 = b => crypto.createHash('md5').update(b).digest('hex');

let uploaded = 0, verified = 0; const errors = [];
for (const p of data.products) {
  if (!p.media?.primary) continue;
  const file = path.join(SRC, `${p.id}.webp`), dest = `products/${p.id}.webp`;
  const body = fs.readFileSync(file);
  const {error} = await supabase.storage.from('product-images').upload(dest, body, {contentType: 'image/webp', cacheControl: '31536000', upsert: true});
  if (error) { errors.push(`${p.sku}: ${error.message}`); continue; }
  uploaded++;
  const res = await fetch(supabase.storage.from('product-images').getPublicUrl(dest).data.publicUrl);
  const back = Buffer.from(await res.arrayBuffer());
  if (res.ok && md5(back) === md5(body)) verified++; else errors.push(`${p.sku}: public URL check failed (HTTP ${res.status})`);
}
console.log(`uploaded ${uploaded}/22, public URL returns identical bytes for ${verified}/22`);
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
