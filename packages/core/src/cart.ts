/* Customer cart (M7). The browser only says WHICH product, size and quantity; name, SKU, price and stock are resolved here
   from the database and every total by pricing.ts, the same way for the cart page, the checkout page and order creation.
   A signed-in customer has one active cart (carts + cart_items); a guest's browser cart is merged into it after login.
   Every function is scoped to the signed-in customer. */
import { sql, type Db, type Queryable, type Tx } from '@kitsyuu/db';
import { cartLineInput, ConflictError, MAX_LINES_PER_REQUEST, MAX_QTY_PER_LINE, NotFoundError, type CartLineInput } from '@kitsyuu/contracts';
import type { CustomerPrincipal } from '@kitsyuu/auth';
import { priceOrder, type CartTotals, type CommerceConfig, type PaymentChoice, type ShipTo } from './pricing.ts';
import { basePriceSql, effectivePriceSql } from './sale.ts';

export type LineProblem = 'unavailable' | 'out_of_stock' | 'insufficient_stock';
export interface PricedLine {
  variantId: string; productId: string; slug: string; sku: string; name: string; size: string; imagePath: string | null;
  /** Third pass: the colour (Colour value and its name) of a product that comes in colours; null otherwise. */
  colour: string | null; colourLabel: string | null;
  unitPaise: number; qty: number; lineTotalPaise: number;
  /** Units that can be bought now (min of stock and the per-line limit); 0 when the size cannot be bought. */
  available: number; problem: LineProblem | null;
}
export interface PricedCart { lines: PricedLine[]; totals: CartTotals; canCheckout: boolean; removed: number }

/** "Hoodie, Black, size M" (the colour only for products that come in colours). */
export const lineLabel = (l: { name: string; size: string; colourLabel?: string | null }) => `${l.name}, ${l.colourLabel ? `${l.colourLabel}, ` : ''}size ${l.size}`;
const PROBLEM_TEXT: Record<LineProblem, (l: PricedLine) => string> = {
  unavailable: l => `${lineLabel(l)}, is no longer available.`,
  out_of_stock: l => `${lineLabel(l)}, is sold out.`,
  insufficient_stock: l => `Only ${l.available} left of ${lineLabel(l)}.`,
};
export const lineProblemText = (l: PricedLine) => (l.problem ? PROBLEM_TEXT[l.problem](l) : '');

export type VariantRow = {
  variant_id: string; product_id: string; slug: string; size: string; sku: string; name: string; stock_qty: number; is_active: boolean;
  unit_paise: number; base_paise: number; image_path: string | null; colour_slug: string | null; colour_label: string | null;
};
/** Sizes of products on sale, with the price that applies (a size may override its product's price). */
export const variantQuery = (q: Queryable) => q.selectFrom('product_variants as v').innerJoin('products as p', 'p.id', 'v.product_id')
  .select(['v.id as variant_id', 'v.product_id', 'p.slug', 'v.size', 'v.sku', 'p.name', 'v.stock_qty', 'v.is_active', 'v.colour_slug',
    effectivePriceSql.as('unit_paise'), basePriceSql.as('base_paise'),   // the sale price while a sale runs (client change request)
    sql<string | null>`(select av.label from public.attribute_values av where av.attribute_id = 'colour' and av.slug = v.colour_slug)`.as('colour_label'),
    // The picture of the size's colour first (third pass), then the product's main picture.
    sql<string | null>`(select i.storage_path from public.product_images i where i.product_id = p.id
      order by (i.colour_slug is not distinct from v.colour_slug) desc, i.is_primary desc, i.sort_order limit 1)`.as('image_path')])
  .where('p.status', '=', 'active');           // the website role only sees active products anyway (RLS)

/** One cart line priced from its size row (shared with draft orders). */
export function pricedLine(v: VariantRow, qty: number): PricedLine {
  const available = v.is_active ? Math.min(v.stock_qty, MAX_QTY_PER_LINE) : 0;
  const problem: LineProblem | null = !v.is_active ? 'unavailable' : v.stock_qty <= 0 ? 'out_of_stock' : qty > v.stock_qty ? 'insufficient_stock' : null;
  return { variantId: v.variant_id, productId: v.product_id, slug: v.slug, sku: v.sku, name: v.name, size: v.size, imagePath: v.image_path,
    colour: v.colour_slug, colourLabel: v.colour_slug ? (v.colour_label ?? v.colour_slug) : null,
    unitPaise: v.unit_paise, qty, lineTotalPaise: v.unit_paise * qty, available, problem };
}

/** The size of a product in a colour (no colour = a product without colours). */
const bySize = (q: Queryable, productId: string, size: string, colour?: string | null) => {
  const base = variantQuery(q).where('v.product_id', '=', productId).where('v.size', '=', size);
  return colour ? base.where('v.colour_slug', '=', colour) : base.where('v.colour_slug', 'is', null);
};
async function variantFor(q: Queryable, productId: string, size: string, colour?: string | null): Promise<VariantRow> {
  const v = await bySize(q, productId, size, colour).executeTakeFirst();
  if (!v) {
    const coloured = !colour && await q.selectFrom('product_variants').select('id').where('product_id', '=', productId).where('colour_slug', 'is not', null).executeTakeFirst();
    throw new NotFoundError(coloured ? 'Choose a colour.' : 'That product or size is not available.');
  }
  return v;
}

// ---------- the customer's active cart ----------
async function activeCartId(q: Queryable, customerId: string): Promise<string | null> {
  return (await q.selectFrom('carts').select('id').where('customer_id', '=', customerId).where('status', '=', 'active').executeTakeFirst())?.id ?? null;
}
/** The customer's active cart, created on first use; locked for the rest of the transaction. */
export async function lockActiveCart(tx: Tx, customerId: string): Promise<string> {
  await tx.insertInto('carts').values({ customer_id: customerId })
    .onConflict(oc => oc.column('customer_id').where('status', '=', 'active').where('customer_id', 'is not', null).doNothing()).execute();
  const c = await tx.selectFrom('carts').select('id').where('customer_id', '=', customerId).where('status', '=', 'active').forUpdate().executeTakeFirstOrThrow();
  return c.id;
}

/** The lines of a cart priced from the database. Lines whose product is no longer on sale are removed (and counted).
    Lines with a problem are shown but not counted in the totals. */
export async function priceCart(q: Queryable, cartId: string | null, opts: { config?: CommerceConfig; customerId?: string | null; shipTo?: ShipTo | null; payment?: PaymentChoice | null } = {}): Promise<PricedCart> {
  const items = cartId ? await q.selectFrom('cart_items').select(['id', 'variant_id', 'qty']).where('cart_id', '=', cartId).orderBy('created_at').orderBy('id').execute() : [];
  const rows = items.length ? await variantQuery(q).where('v.id', 'in', items.map(i => i.variant_id)).execute() : [];
  const byVariant = new Map(rows.map(r => [r.variant_id, r]));
  const gone = items.filter(i => !byVariant.has(i.variant_id));
  if (gone.length) await q.deleteFrom('cart_items').where('id', 'in', gone.map(i => i.id)).execute();
  const lines = items.filter(i => byVariant.has(i.variant_id)).map(i => pricedLine(byVariant.get(i.variant_id)!, i.qty));
  const totals = await priceOrder(q, lines.filter(l => !l.problem), { ...opts, cartId });
  return { lines, totals, canCheckout: lines.length > 0 && lines.every(l => !l.problem), removed: gone.length };
}

export async function getCustomerCart(db: Db, p: CustomerPrincipal, config?: CommerceConfig, shipTo?: ShipTo | null, payment?: PaymentChoice | null): Promise<PricedCart> {
  return priceCart(db, await activeCartId(db, p.customerId), { config, customerId: p.customerId, shipTo: shipTo ?? null, payment: payment ?? null });
}

const vLabel = (v: VariantRow) => lineLabel({ name: v.name, size: v.size, colourLabel: v.colour_slug ? (v.colour_label ?? v.colour_slug) : null });
const onlyLeft = (v: VariantRow) => `Only ${v.stock_qty} of ${vLabel(v)}, ${v.stock_qty === 1 ? 'is' : 'are'} available.`;

/** Adds units of a size (the same size merges into one line, at most MAX_QTY_PER_LINE). Refused beyond the stock. */
export async function addCartLine(db: Db, p: CustomerPrincipal, input: CartLineInput): Promise<{ qty: number; capped: boolean }> {
  return db.transaction().execute(async tx => {
    const cartId = await lockActiveCart(tx, p.customerId);
    const v = await variantFor(tx, input.productId, input.size, input.colour);
    if (!v.is_active || v.stock_qty <= 0) throw new ConflictError(`${vLabel(v)}, is sold out.`);
    const existing = await tx.selectFrom('cart_items').select(['id', 'qty']).where('cart_id', '=', cartId).where('variant_id', '=', v.variant_id).executeTakeFirst();
    const wanted = (existing?.qty ?? 0) + input.qty;
    const qty = Math.min(wanted, MAX_QTY_PER_LINE);
    if (qty > v.stock_qty) {
      throw new ConflictError(existing
        ? `${onlyLeft(v)} ${existing.qty} ${existing.qty === 1 ? 'is' : 'are'} already in your cart.`
        : onlyLeft(v));
    }
    if (existing) await tx.updateTable('cart_items').set({ qty }).where('id', '=', existing.id).execute();
    else await tx.insertInto('cart_items').values({ cart_id: cartId, variant_id: v.variant_id, qty }).execute();
    return { qty, capped: wanted > MAX_QTY_PER_LINE };
  });
}

/** Sets the quantity of a line (1–MAX_QTY_PER_LINE). Refused beyond the stock. */
export async function setCartLineQty(db: Db, p: CustomerPrincipal, input: CartLineInput): Promise<void> {
  await db.transaction().execute(async tx => {
    const cartId = await lockActiveCart(tx, p.customerId);
    const v = await variantFor(tx, input.productId, input.size, input.colour);
    const line = await tx.selectFrom('cart_items').select('id').where('cart_id', '=', cartId).where('variant_id', '=', v.variant_id).executeTakeFirst();
    if (!line) throw new NotFoundError('That item is no longer in your cart.');
    if (input.qty > v.stock_qty) throw new ConflictError(v.stock_qty > 0 ? onlyLeft(v) : `${vLabel(v)}, is sold out.`);
    await tx.updateTable('cart_items').set({ qty: input.qty }).where('id', '=', line.id).execute();
  });
}

export async function removeCartLine(db: Db, p: CustomerPrincipal, input: { productId: string; size: string; colour?: string | null }): Promise<void> {
  const cartId = await activeCartId(db, p.customerId);
  if (!cartId) return;
  let sizes = db.selectFrom('product_variants').select('id').where('product_id', '=', input.productId).where('size', '=', input.size);
  sizes = input.colour ? sizes.where('colour_slug', '=', input.colour) : sizes.where('colour_slug', 'is', null);
  await db.deleteFrom('cart_items').where('cart_id', '=', cartId).where('variant_id', 'in', sizes).execute();
}

/** Merges a guest (browser) cart after login. Invalid, unknown or sold-out lines are skipped; for a size already in the
    cart the larger quantity wins (so logging in twice does not double it); quantities are capped by stock. */
export async function mergeGuestCart(db: Db, p: CustomerPrincipal, raw: unknown[]): Promise<{ merged: number; skipped: number }> {
  const wanted = new Map<string, CartLineInput>();
  let skipped = 0;
  for (const r of raw.slice(0, MAX_LINES_PER_REQUEST)) {
    const x = r as Record<string, unknown> | null;
    const parsed = cartLineInput.safeParse({ productId: x?.id ?? x?.productId, size: x?.size, qty: x?.qty, colour: x?.colour });
    if (!parsed.success) { skipped++; continue; }
    const k = `${parsed.data.productId}|${parsed.data.colour ?? ''}|${parsed.data.size}`, prev = wanted.get(k);
    wanted.set(k, prev ? { ...prev, qty: Math.max(prev.qty, parsed.data.qty) } : parsed.data);
  }
  if (!wanted.size) return { merged: 0, skipped };
  return db.transaction().execute(async tx => {
    const cartId = await lockActiveCart(tx, p.customerId);
    const existing = new Map((await tx.selectFrom('cart_items').select(['id', 'variant_id', 'qty']).where('cart_id', '=', cartId).execute()).map(i => [i.variant_id, i]));
    let merged = 0;
    for (const w of wanted.values()) {
      const v = await bySize(tx, w.productId, w.size, w.colour).executeTakeFirst();
      if (!v || !v.is_active || v.stock_qty <= 0) { skipped++; continue; }
      const cur = existing.get(v.variant_id);
      const qty = Math.min(Math.max(cur?.qty ?? 0, w.qty), MAX_QTY_PER_LINE, v.stock_qty);
      if (cur) { if (qty !== cur.qty) await tx.updateTable('cart_items').set({ qty }).where('id', '=', cur.id).execute(); }
      else await tx.insertInto('cart_items').values({ cart_id: cartId, variant_id: v.variant_id, qty }).execute();
      merged++;
    }
    return { merged, skipped };
  });
}

/** Client change request: how often the store re-syncs a cart that has items with the server (current prices, sale prices,
    stock), from Settings → Checkout → "Cart refresh interval". The client asked for 30 minutes. A refresh never removes or
    reserves anything. */
export const CART_REFRESH_DEFAULT_MINUTES = 60;   // 2026-10-01: every 60 minutes (was 30); Settings → Checkout can change it
export async function cartRefreshMinutes(q: Queryable): Promise<number> {
  const r = await q.selectFrom('settings').select('value').where('key', '=', 'checkout.cart_refresh_minutes').executeTakeFirst();
  const n = Number(r?.value);
  return Number.isInteger(n) && n >= 5 && n <= 1440 ? n : CART_REFRESH_DEFAULT_MINUTES;
}

/** A guest's browser cart checked against the stock now (2026-10-01): how many of each line can be bought (capped at the
    per-line limit) and what is wrong, without storing anything. Only sizes of products on sale are known. */
export async function checkCartAvailability(q: Queryable, lines: { productId: string; size: string; colour?: string | null; qty: number }[]) {
  const wanted = lines.slice(0, MAX_LINES_PER_REQUEST * 5);
  const ids = [...new Set(wanted.map(l => l.productId).filter(id => typeof id === 'string' && id.length <= 40))];
  const rows = ids.length ? await variantQuery(q).where('v.product_id', 'in', ids).execute() : [];
  return wanted.map(l => {
    const v = rows.find(r => r.product_id === l.productId && r.size === l.size && (r.colour_slug ?? null) === (l.colour ?? null));
    if (!v) return { productId: l.productId, size: l.size, colour: l.colour ?? null, available: 0, problem: 'unavailable' as LineProblem, message: 'This item is no longer available.' };
    const p = pricedLine(v, Math.max(1, Math.trunc(Number(l.qty)) || 1));
    return { productId: l.productId, size: l.size, colour: l.colour ?? null, available: p.available, problem: p.problem, message: p.problem ? lineProblemText(p) : null };
  });
}
