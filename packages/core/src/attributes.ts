/* Product attributes: the business defines attributes (Fabric, Sleeve length, Occasion, …) and their values, then tags
   products with them; the storefront turns each active attribute into a filter. Nothing is pre-filled by the platform.
   Attribute ids and value slugs never change once created (the store uses them in links: /shop?fabric=cotton).
   Definitions need categories.write (they shape the catalogue like categories do); tagging a product needs products.write.
   Every change: permission check → row locks → stale check → change + audit record in ONE transaction.
   Client change request (tags): values are managed like tags. Names are unique per attribute ignoring case ("Black",
   "black" and "BLACK" are one value); an attribute takes one value per product (single) or several (multi); a value is
   deactivated instead of deleted once products use it (they keep it; it is no longer offered in the store filters or for
   new tagging). Colour is one of these attributes (id "colour"), so the store's colour filter and, later, colour variants
   use the same values instead of a second list. */
import { recordAudit, sql, type Db } from '@kitsyuu/db';
import {
  ConflictError, DomainError, NotFoundError, type AddAttributeValueInput, type CreateAttributeInput, type RenameAttributeValueInput,
  type SetAttributeActiveInput, type SetAttributeValueActiveInput, type SetProductAttributesInput, type UpdateAttributeInput
} from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const audit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });

/** "Off-White / Cream" → "off-white-cream". Empty when the label has no Latin letters or digits. */
export const slugify = (label: string) => label.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

export type AttributeRow = {
  id: string; label: string; description: string; isActive: boolean; sortOrder: number; selection: 'single' | 'multi';
  values: { slug: string; label: string; products: number; isActive: boolean; swatch: string | null }[]; products: number;
};

/** All attributes with their values and how many products use each (for the admin). */
export async function listAttributes(db: Db, actor: StaffPrincipal): Promise<AttributeRow[]> {
  if (!can(actor, 'categories.read') && !can(actor, 'products.read')) requirePermission(actor, 'categories.read');
  const [attrs, values] = await Promise.all([
    db.selectFrom('attributes as a').select(['a.id', 'a.label', 'a.description', 'a.is_active', 'a.sort_order', 'a.selection',
      sql<number>`(select count(distinct pav.product_id)::int from public.product_attribute_values pav where pav.attribute_id = a.id)`.as('products')])
      .orderBy('a.sort_order').orderBy('a.id').execute(),
    db.selectFrom('attribute_values as v').select(['v.attribute_id', 'v.slug', 'v.label', 'v.is_active', 'v.swatch',
      sql<number>`(select count(*)::int from public.product_attribute_values pav where pav.attribute_id = v.attribute_id and pav.value_slug = v.slug)`.as('products')])
      .orderBy('v.sort_order').orderBy('v.slug').execute()
  ]);
  return attrs.map(a => ({
    id: a.id, label: a.label, description: a.description, isActive: a.is_active, sortOrder: a.sort_order, products: a.products, selection: a.selection,
    values: values.filter(v => v.attribute_id === a.id).map(v => ({ slug: v.slug, label: v.label, products: v.products, isActive: v.is_active, swatch: v.swatch }))
  }));
}

export async function createAttribute(db: Db, actor: StaffPrincipal, input: CreateAttributeInput, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  const id = input.id ?? slugify(input.label).replace(/^[^a-z]+/, '');
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) throw new DomainError('invalid', 'This name cannot be used as a link id. Use Latin letters, or enter an id.');
  return db.transaction().execute(async tx => {
    // Ids that the shop page already uses as query parameters cannot become attribute ids.
    if (RESERVED.has(id)) throw new DomainError('invalid', `"${id}" is used by the store itself. Choose another name or id.`);
    if (await tx.selectFrom('attributes').select('id').where('id', '=', id).executeTakeFirst()) throw new ConflictError(`An attribute with the id "${id}" already exists.`);
    if (await tx.selectFrom('attributes').select('id').where(sql<string>`lower(label)`, '=', input.label.toLowerCase()).executeTakeFirst())
      throw new ConflictError(`An attribute called "${input.label}" already exists.`);
    const { max } = await tx.selectFrom('attributes').select(sql<number>`coalesce(max(sort_order), -1)::int`.as('max')).executeTakeFirstOrThrow();
    const row = { id, label: input.label, description: input.description, sort_order: max + 1, is_active: true, selection: input.selection };
    await tx.insertInto('attributes').values(row).execute();
    await recordAudit(tx, { ...audit(actor, ctx), action: 'attribute.create', entityType: 'attributes', entityId: id, after: row });
    return { id };
  });
}
const RESERVED = new Set(['category', 'collection', 'sort', 'type', 'size', 'color', 'min', 'max', 'stock', 'q', 'page', 'rating']);

export async function updateAttribute(db: Db, actor: StaffPrincipal, input: UpdateAttributeInput, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  return db.transaction().execute(async tx => {
    const a = await tx.selectFrom('attributes').select(['label', 'description', 'selection']).where('id', '=', input.attributeId).forUpdate().executeTakeFirst();
    if (!a) throw new NotFoundError('Attribute not found.');
    if (a.label !== input.expectedLabel) throw new ConflictError('This attribute was changed by someone else since you opened the page. Reload and try again.');
    const selection = input.selection ?? a.selection;               // not sent: unchanged
    const next = { label: input.label, description: input.description, selection };
    const changed = (['label', 'description', 'selection'] as const).filter(k => a[k] !== next[k]);
    if (!changed.length) return { changed: 0 };
    if (a.label.toLowerCase() !== input.label.toLowerCase() && await tx.selectFrom('attributes').select('id').where('id', '!=', input.attributeId)
      .where(sql<string>`lower(label)`, '=', input.label.toLowerCase()).executeTakeFirst()) throw new ConflictError(`An attribute called "${input.label}" already exists.`);
    if (selection === 'single' && a.selection !== 'single') {
      const { n } = await tx.selectFrom(eb => eb.selectFrom('product_attribute_values').select('product_id').where('attribute_id', '=', input.attributeId)
        .groupBy('product_id').having(sql<number>`count(*)`, '>', 1).as('x')).select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
      if (n > 0) throw new ConflictError(`${n} product${n === 1 ? ' has' : 's have'} more than one ${a.label} value. Leave one value on ${n === 1 ? 'it' : 'each'} first.`);
    }
    await tx.updateTable('attributes').set(next).where('id', '=', input.attributeId).execute();
    await recordAudit(tx, { ...audit(actor, ctx), action: 'attribute.update', entityType: 'attributes', entityId: input.attributeId,
      before: Object.fromEntries(changed.map(k => [k, a[k]])), after: Object.fromEntries(changed.map(k => [k, next[k]])) });
    return { changed: changed.length };
  });
}

export async function setAttributeActive(db: Db, actor: StaffPrincipal, input: SetAttributeActiveInput, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  await db.transaction().execute(async tx => {
    const a = await tx.selectFrom('attributes').select(['is_active']).where('id', '=', input.attributeId).forUpdate().executeTakeFirst();
    if (!a) throw new NotFoundError('Attribute not found.');
    if (a.is_active !== input.expectedActive) throw new ConflictError('This attribute was changed by someone else since you opened the page. Reload and try again.');
    if (a.is_active === input.active) return;
    await tx.updateTable('attributes').set({ is_active: input.active }).where('id', '=', input.attributeId).execute();
    await recordAudit(tx, { ...audit(actor, ctx), action: 'attribute.status_update', entityType: 'attributes', entityId: input.attributeId,
      before: { is_active: a.is_active }, after: { is_active: input.active } });
  });
}

/** Swaps the attribute with its previous/next one (the order of the filters in the store). */
export async function moveAttribute(db: Db, actor: StaffPrincipal, input: { attributeId: string; direction: 'up' | 'down' }, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  return db.transaction().execute(async tx => {
    const all = await tx.selectFrom('attributes').select(['id', 'sort_order']).orderBy('sort_order').orderBy('id').forUpdate().execute();
    return swap(all.map(r => ({ key: r.id, sort: r.sort_order })), input.attributeId, input.direction, async (k, sort) => {
      await tx.updateTable('attributes').set({ sort_order: sort }).where('id', '=', k).execute();
    }, (a, b) => recordAudit(tx, { ...audit(actor, ctx), action: 'attribute.reorder', entityType: 'attributes', entityId: a.key,
      before: { sort_order: a.sort }, after: { sort_order: b.sort }, metadata: { swapped_with: b.key, direction: input.direction } }));
  });
}

export async function addAttributeValue(db: Db, actor: StaffPrincipal, input: AddAttributeValueInput, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  const slug = input.slug ?? slugify(input.label);
  if (slug.length < 1) throw new DomainError('invalid', 'This name has no letters or digits to build a link id from. Enter an id.');
  return db.transaction().execute(async tx => {
    const a = await tx.selectFrom('attributes').select('id').where('id', '=', input.attributeId).forUpdate().executeTakeFirst();
    if (!a) throw new NotFoundError('Attribute not found.');
    // One value per name, whatever the letter case ("Black", "black", "BLACK"); the name keeps the case staff typed.
    const same = await tx.selectFrom('attribute_values').select(['slug', 'label', 'is_active']).where('attribute_id', '=', a.id)
      .where(eb => eb.or([eb('slug', '=', slug), eb(sql<string>`lower(label)`, '=', input.label.toLowerCase())])).executeTakeFirst();
    if (same) throw new ConflictError(`"${same.label}" already exists${same.is_active ? '' : ' (deactivated: reactivate it instead)'}.`);
    const { max } = await tx.selectFrom('attribute_values').select(sql<number>`coalesce(max(sort_order), -1)::int`.as('max')).where('attribute_id', '=', a.id).executeTakeFirstOrThrow();
    const row = { attribute_id: a.id, slug, label: input.label, sort_order: max + 1, swatch: input.swatch ?? null };
    await tx.insertInto('attribute_values').values(row).execute();
    await recordAudit(tx, { ...audit(actor, ctx), action: 'attribute.value_add', entityType: 'attributes', entityId: a.id, after: { slug, label: input.label } });
    return { slug };
  });
}

export async function renameAttributeValue(db: Db, actor: StaffPrincipal, input: RenameAttributeValueInput, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  return db.transaction().execute(async tx => {
    const v = await tx.selectFrom('attribute_values').select(['label', 'swatch']).where('attribute_id', '=', input.attributeId).where('slug', '=', input.slug).forUpdate().executeTakeFirst();
    if (!v) throw new NotFoundError('Value not found.');
    const swatch = input.swatch === undefined ? v.swatch : input.swatch;
    if (v.label === input.label && v.swatch === swatch) return { changed: 0 };
    if (await tx.selectFrom('attribute_values').select('slug').where('attribute_id', '=', input.attributeId).where('slug', '!=', input.slug)
      .where(sql<string>`lower(label)`, '=', input.label.toLowerCase()).executeTakeFirst()) throw new ConflictError(`"${input.label}" already exists.`);
    await tx.updateTable('attribute_values').set({ label: input.label, swatch }).where('attribute_id', '=', input.attributeId).where('slug', '=', input.slug).execute();
    await recordAudit(tx, { ...audit(actor, ctx), action: 'attribute.value_rename', entityType: 'attributes', entityId: input.attributeId,
      before: { slug: input.slug, label: v.label, swatch: v.swatch }, after: { slug: input.slug, label: input.label, swatch } });
    return { changed: 1 };
  });
}

export async function moveAttributeValue(db: Db, actor: StaffPrincipal, input: { attributeId: string; slug: string; direction: 'up' | 'down' }, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  return db.transaction().execute(async tx => {
    const all = await tx.selectFrom('attribute_values').select(['slug', 'sort_order']).where('attribute_id', '=', input.attributeId)
      .orderBy('sort_order').orderBy('slug').forUpdate().execute();
    return swap(all.map(r => ({ key: r.slug, sort: r.sort_order })), input.slug, input.direction, async (k, sort) => {
      await tx.updateTable('attribute_values').set({ sort_order: sort }).where('attribute_id', '=', input.attributeId).where('slug', '=', k).execute();
    }, (a, b) => recordAudit(tx, { ...audit(actor, ctx), action: 'attribute.value_reorder', entityType: 'attributes', entityId: input.attributeId,
      metadata: { slug: a.key, swapped_with: b.key, direction: input.direction } }));
  });
}

/** Deactivates / reactivates a value. Products keep it either way; an inactive value is not offered in the store filters or for
    new tagging. This is how a value in use is retired (it is never deleted while products have it). */
export async function setAttributeValueActive(db: Db, actor: StaffPrincipal, input: SetAttributeValueActiveInput, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  return db.transaction().execute(async tx => {
    const v = await tx.selectFrom('attribute_values').select(['label', 'is_active']).where('attribute_id', '=', input.attributeId).where('slug', '=', input.slug).forUpdate().executeTakeFirst();
    if (!v) throw new NotFoundError('Value not found.');
    if (v.is_active === input.active) return { changed: 0 };
    await tx.updateTable('attribute_values').set({ is_active: input.active }).where('attribute_id', '=', input.attributeId).where('slug', '=', input.slug).execute();
    await recordAudit(tx, { ...audit(actor, ctx), action: 'attribute.value_status_update', entityType: 'attributes', entityId: input.attributeId,
      before: { slug: input.slug, label: v.label, is_active: v.is_active }, after: { slug: input.slug, is_active: input.active } });
    return { changed: 1 };
  });
}

/** Deletes a value. Refused while any product has it (untag the products first), so no product loses data silently. */
export async function deleteAttributeValue(db: Db, actor: StaffPrincipal, input: { attributeId: string; slug: string }, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  await db.transaction().execute(async tx => {
    const v = await tx.selectFrom('attribute_values').select('label').where('attribute_id', '=', input.attributeId).where('slug', '=', input.slug).forUpdate().executeTakeFirst();
    if (!v) throw new NotFoundError('Value not found.');
    const used = await tx.selectFrom('product_attribute_values').select(sql<number>`count(*)::int`.as('n'))
      .where('attribute_id', '=', input.attributeId).where('value_slug', '=', input.slug).executeTakeFirstOrThrow();
    if (used.n > 0) throw new ConflictError(`${used.n} product${used.n === 1 ? ' has' : 's have'} this value. Remove it from ${used.n === 1 ? 'that product' : 'those products'} first.`);
    await tx.deleteFrom('attribute_values').where('attribute_id', '=', input.attributeId).where('slug', '=', input.slug).execute();
    await recordAudit(tx, { ...audit(actor, ctx), action: 'attribute.value_delete', entityType: 'attributes', entityId: input.attributeId, before: { slug: input.slug, label: v.label } });
  });
}

/** The attribute values a product has, as "attributeId:slug" keys. */
export async function getProductAttributes(db: Db, actor: StaffPrincipal, productId: string): Promise<string[]> {
  requirePermission(actor, 'products.read');
  const rows = await db.selectFrom('product_attribute_values').select(['attribute_id', 'value_slug']).where('product_id', '=', productId).execute();
  return rows.map(r => `${r.attribute_id}:${r.value_slug}`);
}

/** Replaces the product's attribute values with the given set (only the differences are written and audited). */
export async function setProductAttributes(db: Db, actor: StaffPrincipal, input: SetProductAttributesInput, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  return db.transaction().execute(async tx => {
    const p = await tx.selectFrom('products').select('id').where('id', '=', input.productId).forUpdate().executeTakeFirst();
    if (!p) throw new NotFoundError('Product not found.');
    const want = new Set(input.values.map(v => `${v.attributeId}:${v.slug}`));
    let inactive: { attribute_id: string; slug: string; label: string }[] = [];
    if (want.size) {
      // FOR SHARE: a value cannot be deleted while it is being assigned here.
      const known = await tx.selectFrom('attribute_values as v').innerJoin('attributes as a', 'a.id', 'v.attribute_id')
        .select(['v.attribute_id', 'v.slug', 'v.label', 'v.is_active', 'a.label as attribute_label', 'a.selection'])
        .where(eb => eb.or(input.values.map(v => eb.and([eb('v.attribute_id', '=', v.attributeId), eb('v.slug', '=', v.slug)])))).forShare('v').execute();
      if (known.length !== want.size) throw new DomainError('invalid', 'One of the selected values no longer exists. Reload and try again.');
      for (const a of new Set(known.filter(k => k.selection === 'single').map(k => k.attribute_id))) {
        const picked = known.filter(k => k.attribute_id === a);
        if (picked.length > 1) throw new DomainError('invalid', `${picked[0].attribute_label} takes one value. Choose one of: ${picked.map(k => k.label).join(', ')}.`);
      }
      inactive = known.filter(k => !k.is_active);
    }
    const have = new Set((await tx.selectFrom('product_attribute_values').select(['attribute_id', 'value_slug']).where('product_id', '=', p.id).execute())
      .map(r => `${r.attribute_id}:${r.value_slug}`));
    // A deactivated value the product already has may stay; it cannot be given to it anew.
    const newlyInactive = inactive.filter(k => !have.has(`${k.attribute_id}:${k.slug}`));
    if (newlyInactive.length) throw new DomainError('invalid', `${newlyInactive.map(k => k.label).join(', ')} ${newlyInactive.length === 1 ? 'is' : 'are'} deactivated and cannot be added.`);
    const added = [...want].filter(k => !have.has(k)), removed = [...have].filter(k => !want.has(k));
    if (!added.length && !removed.length) return { changed: 0 };
    for (const k of removed) {
      const [attributeId, slug] = k.split(':');
      await tx.deleteFrom('product_attribute_values').where('product_id', '=', p.id).where('attribute_id', '=', attributeId).where('value_slug', '=', slug).execute();
    }
    if (added.length) await tx.insertInto('product_attribute_values')
      .values(added.map(k => { const [attribute_id, value_slug] = k.split(':'); return { product_id: p.id, attribute_id, value_slug }; })).execute();
    await recordAudit(tx, { ...audit(actor, ctx), action: 'product.attributes_update', entityType: 'products', entityId: p.id,
      before: { values: [...have].sort() }, after: { values: [...want].sort() }, metadata: { added, removed } });
    return { changed: added.length + removed.length };
  });
}

async function swap<T extends { key: string; sort: number }>(list: T[], key: string, direction: 'up' | 'down',
  set: (key: string, sort: number) => Promise<void>, log: (a: T, b: T) => Promise<unknown>) {
  const i = list.findIndex(r => r.key === key);
  if (i < 0) throw new NotFoundError('Not found.');
  const j = direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= list.length) return { moved: false };
  const [a, b] = [list[i], list[j]];
  await set(a.key, b.sort); await set(b.key, a.sort);
  await log(a, b);
  return { moved: true };
}
