/* Client change request: size charts, entered by staff (nothing is pre-filled). A chart has columns (e.g. Chest, Length)
   and one row per size; it is assigned to a category (every product in it, including its subcategories) and/or to single
   products. Which chart a product shows: its own, else its subcategory's, else its category's. Only active charts are
   public (RLS). */
import { recordAudit, sql, type Db, type Queryable } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

export type SizeChartRow = { size: string; values: string[] };
export type SizeChart = { id: string; name: string; unit: 'cm' | 'in'; headers: string[]; rows: SizeChartRow[]; notes: string | null };

/** Parses the chart typed or pasted by staff: the first line is "Size, <column>, <column>…", then one line per size.
    Commas or tabs separate cells (pasting from a spreadsheet works). */
export function parseSizeChartTable(text: string): { headers: string[]; rows: SizeChartRow[] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new DomainError('invalid', 'Enter a header line (Size, then the measurements) and at least one size.');
  const split = (l: string) => l.split(l.includes('\t') ? '\t' : ',').map(c => c.trim());
  const [head, ...body] = lines.map(split);
  const headers = head.slice(1);
  if (!headers.length || headers.length > 8 || headers.some(h => !h || h.length > 30)) throw new DomainError('invalid', 'The header line needs "Size" and 1 to 8 measurement names (each up to 30 characters).');
  if (body.length > 20) throw new DomainError('invalid', 'A chart can have at most 20 sizes.');
  const rows = body.map((c, i) => {
    if (c.length !== head.length) throw new DomainError('invalid', `Line ${i + 2} has ${c.length} cells; it needs ${head.length} (like the header).`);
    if (!c[0] || c[0].length > 12 || c.slice(1).some(v => v.length > 20)) throw new DomainError('invalid', `Line ${i + 2}: check the size name and values.`);
    return { size: c[0], values: c.slice(1) };
  });
  if (new Set(rows.map(r => r.size.toLowerCase())).size !== rows.length) throw new DomainError('invalid', 'Each size may appear only once.');
  return { headers, rows };
}
export const sizeChartTableText = (c: { headers: string[]; rows: SizeChartRow[] }) => [['Size', ...c.headers], ...c.rows.map(r => [r.size, ...r.values])].map(l => l.join(', ')).join('\n');

export async function listSizeCharts(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'products.read');
  const charts = await db.selectFrom('size_charts').select(['id', 'name', 'unit', 'headers', 'rows', 'notes', 'is_active', 'updated_at']).orderBy('name').execute();
  const [cats, prods] = await Promise.all([
    db.selectFrom('categories').select(['id', 'label', 'parent_id', 'size_chart_id']).orderBy('sort_order').execute(),
    db.selectFrom('products').select(['id', 'name', 'sku', 'size_chart_id']).where('status', '!=', 'archived').orderBy('name').execute(),
  ]);
  return { charts: charts.map(c => ({ ...c, rows: c.rows as SizeChartRow[] })), categories: cats, products: prods };
}

export async function saveSizeChart(db: Db, actor: StaffPrincipal,
  input: { chartId?: string; name: string; unit: 'cm' | 'in'; table: string; notes: string | null; active: boolean; categoryIds: string[]; productIds: string[] }, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  const { headers, rows } = parseSizeChartTable(input.table);
  return db.transaction().execute(async tx => {
    const clash = await tx.selectFrom('size_charts').select('id').where(sql`lower(name)`, '=', input.name.toLowerCase()).executeTakeFirst();
    if (clash && clash.id !== input.chartId) throw new ConflictError('A size chart with this name already exists.');
    const row = { name: input.name, unit: input.unit, headers, rows: JSON.stringify(rows), notes: input.notes, is_active: input.active };
    let id = input.chartId;
    if (!id) id = (await tx.insertInto('size_charts').values(row).returning('id').executeTakeFirstOrThrow()).id;
    else if (!Number((await tx.updateTable('size_charts').set(row).where('id', '=', id).executeTakeFirst()).numUpdatedRows)) throw new NotFoundError('Size chart not found.');
    // Assignment: exactly the ticked categories and products point at this chart (others that pointed here are cleared).
    for (const [table, ids] of [['categories', input.categoryIds], ['products', input.productIds]] as const) {
      if (ids.length && (await tx.selectFrom(table).select('id').where('id', 'in', ids).execute()).length !== new Set(ids).size)
        throw new DomainError('invalid', `One of the chosen ${table} no longer exists.`);
      await tx.updateTable(table).set({ size_chart_id: null }).where('size_chart_id', '=', id).$if(ids.length > 0, q => q.where('id', 'not in', ids)).execute();
      if (ids.length) await tx.updateTable(table).set({ size_chart_id: id }).where('id', 'in', ids).execute();
    }
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: input.chartId ? 'size_chart.update' : 'size_chart.create', entityType: 'size_charts', entityId: id,
      after: { name: input.name, unit: input.unit, headers, sizes: rows.length, active: input.active, categories: input.categoryIds, products: input.productIds.length },
      ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
    return { id };
  });
}

/** The chart a product shows (its own, else its subcategory's, else its category's), or null. Active charts only. */
export async function sizeChartForProduct(q: Queryable, productId: string): Promise<SizeChart | null> {
  const r = await q.selectFrom('products as p').leftJoin('categories as sc', 'sc.id', 'p.subcategory_id').innerJoin('categories as c', 'c.id', 'p.category_id')
    .select(sql<string | null>`coalesce(p.size_chart_id, sc.size_chart_id, c.size_chart_id)`.as('chart_id')).where('p.id', '=', productId).executeTakeFirst();
  if (!r?.chart_id) return null;
  const c = await q.selectFrom('size_charts').select(['id', 'name', 'unit', 'headers', 'rows', 'notes']).where('id', '=', r.chart_id).where('is_active', '=', true).executeTakeFirst();
  return c ? { ...c, rows: c.rows as SizeChartRow[] } : null;
}
