import 'server-only';
import { createDb, sql, type Db } from '@kitsyuu/db';
import { guardedDatabaseUrl } from '../db-guard';
import { localImageUrl } from '../catalogue-source';

/* The LOCAL / TEST source of the public catalogue and content (CATALOGUE_SOURCE=database; see lib/catalogue-source.ts).

   It answers the same questions lib/catalogue.ts and lib/content.ts ask the hosted public API, from this machine's
   PostgreSQL, through the store's own database role. Those two files are not changed: they receive this object in place
   of the API client and run the same mapping code on the rows, so the catalogue the pages get has the same shape.

   · Only the exact reads the store makes are answered (the table, the selected columns, the filters and the order are
     checked). Anything else throws: nothing is guessed and nothing falls back to the hosted API.
   · Visibility is the database's own: the store role's row-security rules are the same conditions as the public role's
     (published products, active categories / collections / attributes / size charts, published content).
   · Rows are built as JSON by PostgreSQL itself, as the public API does, so numbers, dates and nulls arrive in the same form.
   · Banners: the store's database role has no access to the banners table (only the public API roles do), and no grant
     is added for it. In this mode there are no banners; it is logged once. That is a known limit of the local source. */

type Result = { data: unknown; error: { message: string; code?: string } | null };
type Filter = { op: 'eq' | 'not-is-null'; column: string; value?: unknown };
type State = { table: string; columns: string; filters: Filter[]; order: string[]; limit: number | null; single: boolean };
const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/\(\s*/g, '(').replace(/\s*\)/g, ')').trim();
/** A read as one line, e.g. "products | id, seo_title, seo_description | status=active | order: - | limit: -". */
const describe = (s: State) => `${s.table} | ${s.columns} | ${s.filters.map(f => (f.op === 'eq' ? `${f.column}=${String(f.value)}` : `${f.column} not null`)).join(' & ') || '-'} | order: ${s.order.join(', ') || '-'} | limit: ${s.limit ?? '-'}${s.single ? ' | single' : ''}`;

/* The catalogue is read with the store's own database connection. CATALOGUE_DATABASE_URL (optional, local only) reads it over a
   connection of its own instead: in production the catalogue and the customer database are separate services, and a test that
   takes the customer database down must still have a catalogue. */
const g = globalThis as unknown as { __kitsyuuCatalogueDb?: Db };
async function source(): Promise<Db> {
  const own = process.env.CATALOGUE_DATABASE_URL;
  if (own) return (g.__kitsyuuCatalogueDb ??= createDb({ connectionString: guardedDatabaseUrl('CATALOGUE_DATABASE_URL', own), max: 3 }));
  return (await import('../server')).db();
}
async function json(query: { execute(db: Db): Promise<{ rows: unknown[] }> }): Promise<unknown> {
  return ((await query.execute(await source())).rows[0] as { j?: unknown } | undefined)?.j ?? null;
}

const PRODUCT_COLUMNS = norm(`id, sku, slug, name, description, category_id, subcategory_id, price_paise, colour_label, colour_swatch, features, is_featured,
  catalogue_ref, material, care, origin, product_variants (*), product_images (*), product_relations!product_relations_product_id_fkey (related_id, kind, position)`);

/* Every read the store makes, keyed by its one-line description. `key` and `locale` of site_content are parameters. */
const READS: Record<string, (s: State) => Promise<unknown>> = {
  'categories | id, label, parent_id, sort_order | - | order: sort_order | limit: -': () =>
    json(sql`select coalesce(json_agg(json_build_object('id', c.id, 'label', c.label, 'parent_id', c.parent_id, 'sort_order', c.sort_order) order by c.sort_order), '[]'::json) as j from public.categories c`),
  [`products | ${PRODUCT_COLUMNS} | status=active | order: created_at, id | limit: -`]: () =>
    json(sql`select coalesce(json_agg(json_build_object(
        'id', p.id, 'sku', p.sku, 'slug', p.slug, 'name', p.name, 'description', p.description, 'category_id', p.category_id, 'subcategory_id', p.subcategory_id,
        'price_paise', p.price_paise, 'colour_label', p.colour_label, 'colour_swatch', p.colour_swatch, 'features', p.features, 'is_featured', p.is_featured,
        'catalogue_ref', p.catalogue_ref, 'material', p.material, 'care', p.care, 'origin', p.origin,
        'product_variants', coalesce((select json_agg(row_to_json(v)) from public.product_variants v where v.product_id = p.id), '[]'::json),
        'product_images', coalesce((select json_agg(row_to_json(i)) from public.product_images i where i.product_id = p.id), '[]'::json),
        'product_relations', coalesce((select json_agg(json_build_object('related_id', r.related_id, 'kind', r.kind, 'position', r.position)) from public.product_relations r where r.product_id = p.id), '[]'::json)
      ) order by p.created_at, p.id), '[]'::json) as j from public.products p where p.status = 'active'`),
  'collections | *, collection_products (product_id, position) | - | order: - | limit: -': () =>
    json(sql`select coalesce(json_agg(to_jsonb(c) || jsonb_build_object('collection_products',
        coalesce((select jsonb_agg(jsonb_build_object('product_id', cp.product_id, 'position', cp.position)) from public.collection_products cp where cp.collection_id = c.id), '[]'::jsonb))), '[]'::json) as j
      from public.collections c`),
  'products | id, price_paise, compare_at_paise, sale_price_paise, sale_starts_at, sale_ends_at | status=active | order: - | limit: -': () =>
    json(sql`select coalesce(json_agg(json_build_object('id', p.id, 'price_paise', p.price_paise, 'compare_at_paise', p.compare_at_paise, 'sale_price_paise', p.sale_price_paise,
        'sale_starts_at', p.sale_starts_at, 'sale_ends_at', p.sale_ends_at)), '[]'::json) as j from public.products p where p.status = 'active'`),
  'size_charts | id, name, unit, headers, rows, notes | - | order: - | limit: -': () =>
    json(sql`select coalesce(json_agg(json_build_object('id', s.id, 'name', s.name, 'unit', s.unit, 'headers', s.headers, 'rows', s.rows, 'notes', s.notes)), '[]'::json) as j from public.size_charts s`),
  'products | id, size_chart_id | status=active & size_chart_id not null | order: - | limit: -': () =>
    json(sql`select coalesce(json_agg(json_build_object('id', p.id, 'size_chart_id', p.size_chart_id)), '[]'::json) as j from public.products p where p.status = 'active' and p.size_chart_id is not null`),
  'categories | id, size_chart_id | size_chart_id not null | order: - | limit: -': () =>
    json(sql`select coalesce(json_agg(json_build_object('id', c.id, 'size_chart_id', c.size_chart_id)), '[]'::json) as j from public.categories c where c.size_chart_id is not null`),
  'v_product_ratings | product_id, average, count | - | order: - | limit: -': () =>
    json(sql`select coalesce(json_agg(json_build_object('product_id', r.product_id, 'average', r.average, 'count', r.count)), '[]'::json) as j from public.v_product_ratings r`),
  'products | id, seo_title, seo_description | status=active | order: - | limit: -': () =>
    json(sql`select coalesce(json_agg(json_build_object('id', p.id, 'seo_title', p.seo_title, 'seo_description', p.seo_description)), '[]'::json) as j from public.products p where p.status = 'active'`),
  'attributes | id, label, sort_order, attribute_values (*) | - | order: sort_order, id | limit: -': () =>
    json(sql`select coalesce(json_agg(json_build_object('id', a.id, 'label', a.label, 'sort_order', a.sort_order,
        'attribute_values', coalesce((select json_agg(row_to_json(v)) from public.attribute_values v where v.attribute_id = a.id), '[]'::json)) order by a.sort_order, a.id), '[]'::json) as j
      from public.attributes a`),
  'product_attribute_values | product_id, attribute_id, value_slug | - | order: - | limit: -': () =>
    json(sql`select coalesce(json_agg(json_build_object('product_id', t.product_id, 'attribute_id', t.attribute_id, 'value_slug', t.value_slug)), '[]'::json) as j from public.product_attribute_values t`),
};

let bannersNoted = false;
async function run(s: State): Promise<Result> {
  const what = describe(s);
  try {
    if (s.table === 'banners') {
      if (!bannersNoted) { bannersNoted = true; console.warn('[catalogue] local database source: banners are not available (the store\'s database role has no access to the banners table); pages show no banner. This is a known limit of CATALOGUE_SOURCE=database.'); }
      return { data: [], error: null };
    }
    if (s.table === 'site_content') {
      const f = Object.fromEntries(s.filters.map(x => [x.column, x.value]));
      if (s.columns !== 'content' || !s.single || s.filters.length !== 3 || s.filters.some(x => x.op !== 'eq') || typeof f.key !== 'string' || typeof f.locale !== 'string' || f.status !== 'published')
        throw new Error(`the local catalogue source does not answer this read: ${what}`);
      const row = await json(sql`select (select json_build_object('content', c.content) from public.site_content c where c.key = ${f.key} and c.locale = ${f.locale} and c.status = 'published' limit 1) as j`);
      return { data: row, error: null };
    }
    const read = READS[what];
    if (!read) throw new Error(`the local catalogue source does not answer this read: ${what}`);
    return { data: await read(s), error: null };
  } catch (e) {
    // As the API client does: the caller decides (a required read fails the page, an optional one is left out).
    const err = e as { message?: string; code?: string };
    console.error('[catalogue] local database source:', err.message ?? e);
    return { data: null, error: { message: err.message ?? 'local database read failed', code: err.code } };
  }
}

class Query implements PromiseLike<Result> {
  private s: State;
  constructor(table: string) { this.s = { table, columns: '', filters: [], order: [], limit: null, single: false }; }
  select(columns: string) { this.s.columns = norm(columns); return this; }
  eq(column: string, value: unknown) { this.s.filters.push({ op: 'eq', column, value }); return this; }
  not(column: string, operator: string, value: unknown) {
    if (operator !== 'is' || value !== null) throw new Error(`the local catalogue source does not answer .not(${column}, ${operator}, …)`);
    this.s.filters.push({ op: 'not-is-null', column }); return this;
  }
  order(column: string, opts?: { ascending?: boolean }) { this.s.order.push(opts?.ascending === false ? `${column} desc` : column); return this; }
  limit(n: number) { this.s.limit = n; return this; }
  maybeSingle() { this.s.single = true; return this; }
  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, no?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> { return run(this.s).then(ok, no); }
}

/** The part of the API client that lib/catalogue.ts and lib/content.ts use, answered from the local database. */
export function localCatalogueClient() {
  return {
    from: (table: string) => new Query(table),
    storage: { from: (_bucket: string) => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: localImageUrl(path) } }) }) },
  };
}

/** For the verification test: the reads this source answers. */
export const LOCAL_READS = Object.keys(READS);
