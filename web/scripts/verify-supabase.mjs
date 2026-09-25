/* Verifies the migrated catalogue in Supabase against data/products.json, using ONLY the publishable (anon) key,
   i.e. exactly what a browser can see through Row Level Security. Also checks that anonymous users cannot write
   or read private tables, and that every product image resolves from Storage.
   Usage: npm run db:verify */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createClient} from '@supabase/supabase-js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const {NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: anon} = process.env;
if (!url || !anon) { console.error('Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/products.json'), 'utf8'));
const sb = createClient(url, anon, {auth: {persistSession: false}});
const out = []; const ok = (n, p, x = '') => out.push(`${p ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const must = r => { if (r.error) throw new Error(r.error.message); return r.data; };

try {
  const products = must(await sb.from('products').select('id, sku, slug, name, category_id, subcategory_id, price_paise, is_featured, data_status, status'));
  const variants = must(await sb.from('product_variants').select('product_id, size, sku, sort_order, stock_qty, stock_source, is_active'));
  const images = must(await sb.from('product_images').select('product_id, storage_path, width, height, is_primary, quality, zoom'));
  const cats = must(await sb.from('categories').select('id, label, parent_id'));
  const na = must(await sb.from('collection_products').select('product_id, position').eq('collection_id', 'new-arrivals').order('position'));

  ok('22 products', products.length === 22, String(products.length));
  ok('110 size variants', variants.length === 110, String(variants.length));
  ok('22 primary images', images.filter(i => i.is_primary).length === 22);
  ok('10 categories', cats.length === 10);
  const byId = Object.fromEntries(products.map(p => [p.id, p]));
  const bad = data.products.filter(p => { const r = byId[p.id]; return !r || r.sku !== p.sku || r.slug !== p.slug || r.name !== p.name || r.category_id !== p.category || r.subcategory_id !== p.subcategory || r.price_paise !== p.price * 100 || r.is_featured !== p.featured; });
  ok('ids, SKUs, slugs, names, categories, prices, Featured match products.json', bad.length === 0, bad.map(p => p.sku).join(','));
  ok('data_status = prototype on all products', products.every(p => p.data_status === 'prototype'));
  ok('10 units of prototype stock on every size', variants.every(v => v.stock_qty === 10 && v.stock_source === 'prototype'));
  ok('sizes and size order match products.json', data.products.every(p => JSON.stringify(variants.filter(v => v.product_id === p.id).sort((a, b) => a.sort_order - b.sort_order).map(v => v.size)) === JSON.stringify(p.variants.map(v => v.size))));
  ok('New Arrivals order preserved', JSON.stringify(na.map(r => r.product_id)) === JSON.stringify(data.collections[0].productIds), na.map(r => r.product_id).join(','));
  ok('images keep prototype quality and zoom off', images.every(i => i.quality === 'prototype' && i.zoom === false));

  // every image resolves from the public bucket (retried: a transient connect timeout must not abort the run)
  const fetchRetry = async (u, tries = 3) => {
    for (let n = 1; ; n++) {
      try { return await fetch(u, {signal: AbortSignal.timeout(15000)}); }
      catch (e) { if (n >= tries) throw e; await new Promise(r => setTimeout(r, 1000 * n)); }
    }
  };
  let okImgs = 0; const missing = [];
  for (const i of images) {
    try {
      const res = await fetchRetry(sb.storage.from('product-images').getPublicUrl(i.storage_path).data.publicUrl);
      if (res.ok && res.headers.get('content-type')?.includes('image/webp')) okImgs++; else missing.push(`${i.storage_path} (${res.status})`);
      await res.arrayBuffer().catch(() => {});
    } catch (e) { missing.push(`${i.storage_path} (${e.cause?.code || e.message})`); }
  }
  ok('all 22 images served from Storage (public URL, image/webp)', okImgs === 22, missing.join(', '));

  // anonymous users cannot write or read private data
  const ins = await sb.from('products').insert({id: 'x-test', sku: 'X-TEST', slug: 'x-test', name: 'x', category_id: 'tops', price_paise: 1});
  ok('anonymous insert into products is rejected', !!ins.error, ins.error?.message);
  const upd = await sb.from('product_variants').update({stock_qty: 999}).eq('sku', 'KTS-OUT-001-M').select();
  ok('anonymous stock change has no effect', !upd.error && upd.data.length === 0);
  for (const t of ['orders', 'profiles', 'cart_items', 'wishlist_items', 'addresses', 'inventory_movements', 'payment_events']) {
    const r = await sb.from(t).select('*', {count: 'exact', head: true});
    ok(`anonymous users see no rows in ${t}`, !!r.error || r.count === 0, r.error?.message);
  }
  const up = await sb.storage.from('product-images').upload('products/anon-test.webp', new Blob(['x'], {type: 'image/webp'}), {contentType: 'image/webp'});
  ok('anonymous image upload is rejected', !!up.error, up.error?.message);
} catch (e) { ok('verification ran', false, e.message); }

console.log(out.join('\n'));
const passed = out.filter(l => l.startsWith('PASS')).length;
console.log(`\n${passed}/${out.length} checks passed`);
process.exitCode = passed === out.length ? 0 : 1;
