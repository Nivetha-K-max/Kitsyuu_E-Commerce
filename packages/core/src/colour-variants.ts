/* Client change request, third pass: colour variants.
   A product can come in several colours; each colour has its own sizes, stock and images. The colour is a value of the
   Colour attribute (Attributes → Colour), so there is ONE list of colours for filters, sizes and images. A product's sizes
   either all have no colour (as every existing product) or all have one: staff give the existing sizes their colour
   first, then add sizes in other colours. SKUs never change: a size keeps its SKU when it is given a colour.
   Every change needs products.write and is audited in the same transaction. */
import { recordAudit, sql, type Db, type Queryable } from '@kitsyuu/db';
import { ConflictError, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';
import { addVariant } from './variants.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });

/** The colours staff can choose (values of the Colour attribute), with swatches. */
export async function listColours(q: Queryable) {
  return q.selectFrom('attribute_values').select(['slug', 'label', 'swatch', 'is_active']).where('attribute_id', '=', 'colour')
    .orderBy('sort_order').orderBy('slug').execute();
}

async function checkColour(q: Queryable, colour: string) {
  const c = await q.selectFrom('attribute_values').select(['label', 'is_active']).where('attribute_id', '=', 'colour').where('slug', '=', colour).executeTakeFirst();
  if (!c) throw new NotFoundError('Add this colour under Attributes → Colour first.');
  if (!c.is_active) throw new ConflictError(`${c.label} is deactivated. Reactivate it under Attributes → Colour, or choose another colour.`);
  return c.label;
}

/** Adds a size in a colour (a coloured product), or a plain size when colour is null (a product without colours). */
export async function addColourVariant(db: Db, actor: StaffPrincipal, input: { productId: string; size: string; colour: string | null }, ctx: MutationContext) {
  if (!input.colour) {
    const coloured = await db.selectFrom('product_variants').select('id').where('product_id', '=', input.productId).where('colour_slug', 'is not', null).executeTakeFirst();
    if (coloured) throw new ConflictError('This product comes in colours: choose the colour of the new size.');
    return addVariant(db, actor, { productId: input.productId, size: input.size }, ctx);
  }
  requirePermission(actor, 'products.write');
  const colour = input.colour;
  return db.transaction().execute(async tx => {
    const p = await tx.selectFrom('products').select(['id', 'sku']).where('id', '=', input.productId).forUpdate().executeTakeFirst();
    if (!p) throw new NotFoundError('Product not found.');
    const label = await checkColour(tx, colour);
    if (await tx.selectFrom('product_variants').select('id').where('product_id', '=', p.id).where('colour_slug', 'is', null).executeTakeFirst())
      throw new ConflictError('Give the existing sizes of this product their colour first (Sizes → Colour), then add sizes in other colours.');
    if (await tx.selectFrom('product_variants').select('id').where('product_id', '=', p.id).where('colour_slug', '=', colour).where(sql`upper(size)`, '=', input.size).executeTakeFirst())
      throw new ConflictError(`Size ${input.size} already exists in ${label}.`);
    const sku = `${p.sku}-${colour.toUpperCase()}-${input.size}`;
    if (await tx.selectFrom('product_variants').select('id').where('sku', '=', sku).executeTakeFirst()) throw new ConflictError(`SKU ${sku} is already used.`);
    const { max } = await tx.selectFrom('product_variants').select(sql<number>`coalesce(max(sort_order), -1)::int`.as('max')).where('product_id', '=', p.id).executeTakeFirstOrThrow();
    const row = { product_id: p.id, size: input.size, colour_slug: colour, sku, sort_order: max + 1, stock_source: 'manual', is_active: true };
    const v = await tx.insertInto('product_variants').values(row).returning(['id', 'stock_qty']).executeTakeFirstOrThrow();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.variant_create', entityType: 'product_variants', entityId: v.id,
      after: { ...row, colour: label, stock_qty: v.stock_qty }, ...auditCtx(ctx) });
    return { variantId: v.id, sku };
  });
}

/** Gives an existing size its colour (or removes it). Its SKU and stock do not change. */
export async function setVariantColour(db: Db, actor: StaffPrincipal, input: { variantId: string; colour: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  return db.transaction().execute(async tx => {
    const v = await tx.selectFrom('product_variants').select(['id', 'product_id', 'size', 'sku', 'colour_slug']).where('id', '=', input.variantId).forUpdate().executeTakeFirst();
    if (!v) throw new NotFoundError('Size not found.');
    if (v.colour_slug === input.colour) return { changed: 0 };
    if (input.colour) await checkColour(tx, input.colour);
    let clash = tx.selectFrom('product_variants').select('id').where('product_id', '=', v.product_id).where('id', '!=', v.id).where(sql`upper(size)`, '=', v.size.toUpperCase());
    clash = input.colour ? clash.where('colour_slug', '=', input.colour) : clash.where('colour_slug', 'is', null);
    if (await clash.executeTakeFirst()) throw new ConflictError(`Size ${v.size} already exists in that colour.`);
    await tx.updateTable('product_variants').set({ colour_slug: input.colour }).where('id', '=', v.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.variant_colour', entityType: 'product_variants', entityId: v.id,
      before: { colour: v.colour_slug }, after: { colour: input.colour }, metadata: { sku: v.sku, product_id: v.product_id }, ...auditCtx(ctx) });
    return { changed: 1 };
  });
}

/** Links an image to one colour of the product (null = the product in general). */
export async function setImageColour(db: Db, actor: StaffPrincipal, input: { imageId: string; colour: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  return db.transaction().execute(async tx => {
    const i = await tx.selectFrom('product_images').select(['id', 'product_id', 'colour_slug']).where('id', '=', input.imageId).forUpdate().executeTakeFirst();
    if (!i) throw new NotFoundError('Image not found.');
    if (i.colour_slug === input.colour) return { changed: 0 };
    if (input.colour) {
      await checkColour(tx, input.colour);
      if (!(await tx.selectFrom('product_variants').select('id').where('product_id', '=', i.product_id).where('colour_slug', '=', input.colour).executeTakeFirst()))
        throw new ConflictError('This product has no size in that colour yet.');
    }
    await tx.updateTable('product_images').set({ colour_slug: input.colour }).where('id', '=', i.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.image_colour', entityType: 'product_images', entityId: i.id,
      before: { colour: i.colour_slug }, after: { colour: input.colour }, metadata: { product_id: i.product_id }, ...auditCtx(ctx) });
    return { changed: 1 };
  });
}

/** A size's colour name for messages and order lines ("Black"), or null. */
export async function colourLabel(q: Queryable, colour: string | null): Promise<string | null> {
  if (!colour) return null;
  return (await q.selectFrom('attribute_values').select('label').where('attribute_id', '=', 'colour').where('slug', '=', colour).executeTakeFirst())?.label ?? colour;
}
