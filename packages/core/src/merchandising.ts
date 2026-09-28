/* M11: merchandising. Collections (curated product lists such as New Arrivals; new ones start hidden), "Complete the
   look" links between products (product_relations, kind styled_with), and bulk status changes. Collections need
   categories.write (they shape the catalogue like categories); product links and status need products.write.
   Every change: permission check → row locks → stale check → change + audit record in ONE transaction. */
import { recordAudit, sql, type Db, type Tx } from '@kitsyuu/db';
import {
  ConflictError, DomainError, NotFoundError, type BulkProductStatusInput, type CreateCollectionInput, type SetCollectionActiveInput,
  type UpdateCollectionInput,
} from '@kitsyuu/contracts';
import { can, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import { setProductStatus } from './products.ts';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const staffAudit = (actor: StaffPrincipal, ctx: MutationContext) => ({ actorType: 'staff' as const, staffId: actor.staffId, ...auditCtx(ctx) });
/** At most this many "Complete the look" products per product (the store shows a short row). */
export const MAX_RELATED = 8;

// ---------------------------------------------------------------- collections
export async function listCollections(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'categories.read');
  const cols = await db.selectFrom('collections as c')
    .select(['c.id', 'c.label', 'c.is_active', 'c.sort_order',
      sql<number>`(select count(*)::int from public.collection_products x where x.collection_id = c.id)`.as('products')])
    .orderBy('c.sort_order').orderBy('c.id').execute();
  return cols.map(c => ({ id: c.id, label: c.label, isActive: c.is_active, products: c.products }));
}

export async function getCollection(db: Db, actor: StaffPrincipal, collectionId: string) {
  requirePermission(actor, 'categories.read');
  const c = await db.selectFrom('collections').select(['id', 'label', 'is_active']).where('id', '=', collectionId).executeTakeFirst();
  if (!c) throw new NotFoundError('Collection not found.');
  const members = await db.selectFrom('collection_products as m').innerJoin('products as p', 'p.id', 'm.product_id')
    .select(['p.id', 'p.sku', 'p.name', 'p.status', 'm.position']).where('m.collection_id', '=', collectionId).orderBy('m.position').orderBy('p.id').execute();
  const candidates = can(actor, 'categories.write')
    ? await db.selectFrom('products').select(['id', 'sku', 'name', 'status']).where('status', '!=', 'archived')
        .where('id', 'not in', db.selectFrom('collection_products').select('product_id').where('collection_id', '=', collectionId)).orderBy('sku').execute()
    : [];
  return { collection: { id: c.id, label: c.label, isActive: c.is_active }, members, candidates };
}

export async function createCollection(db: Db, actor: StaffPrincipal, input: CreateCollectionInput, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  return db.transaction().execute(async tx => {
    if (await tx.selectFrom('collections').select('id').where('id', '=', input.id).executeTakeFirst()) throw new ConflictError(`A collection with the id "${input.id}" already exists.`);
    const { max } = await tx.selectFrom('collections').select(sql<number>`coalesce(max(sort_order), -1)::int`.as('max')).executeTakeFirstOrThrow();
    // New collections start hidden: the store menu lists every active collection, so staff fill it before showing it.
    const row = { id: input.id, label: input.label, data_status: 'official', note: null, is_active: false, sort_order: max + 1 };
    await tx.insertInto('collections').values(row).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'collection.create', entityType: 'collections', entityId: input.id, after: row });
    return { id: input.id };
  });
}

export async function updateCollection(db: Db, actor: StaffPrincipal, input: UpdateCollectionInput, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  return db.transaction().execute(async tx => {
    const c = await tx.selectFrom('collections').select('label').where('id', '=', input.collectionId).forUpdate().executeTakeFirst();
    if (!c) throw new NotFoundError('Collection not found.');
    if (c.label !== input.expectedLabel) throw new ConflictError('This collection was changed by someone else since you opened the page. Reload and try again.');
    if (c.label === input.label) return { changed: 0 };
    await tx.updateTable('collections').set({ label: input.label }).where('id', '=', input.collectionId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'collection.update', entityType: 'collections', entityId: input.collectionId, before: { label: c.label }, after: { label: input.label } });
    return { changed: 1 };
  });
}

export async function setCollectionActive(db: Db, actor: StaffPrincipal, input: SetCollectionActiveInput, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  await db.transaction().execute(async tx => {
    const c = await tx.selectFrom('collections').select('is_active').where('id', '=', input.collectionId).forUpdate().executeTakeFirst();
    if (!c) throw new NotFoundError('Collection not found.');
    if (c.is_active !== input.expectedActive) throw new ConflictError('This collection was changed by someone else since you opened the page. Reload and try again.');
    if (c.is_active === input.active) return;
    if (input.active) {
      const { n } = await tx.selectFrom('collection_products as m').innerJoin('products as p', 'p.id', 'm.product_id')
        .select(sql<number>`count(*)::int`.as('n')).where('m.collection_id', '=', input.collectionId).where('p.status', '=', 'active').executeTakeFirstOrThrow();
      if (n === 0) throw new ConflictError('Add at least one active product before showing this collection in the store.');
    }
    await tx.updateTable('collections').set({ is_active: input.active }).where('id', '=', input.collectionId).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'collection.status_update', entityType: 'collections', entityId: input.collectionId,
      before: { is_active: c.is_active }, after: { is_active: input.active } });
  });
}

/** Swaps the collection with its neighbour (the order of collections in the store menu). */
export async function moveCollection(db: Db, actor: StaffPrincipal, input: { collectionId: string; direction: 'up' | 'down' }, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  return db.transaction().execute(async tx => {
    const all = await tx.selectFrom('collections').select(['id', 'sort_order']).orderBy('sort_order').orderBy('id').forUpdate().execute();
    // Existing rows may share sort_order 0: renumber first so a swap always changes the order.
    for (const [i, r] of all.entries()) if (r.sort_order !== i) await tx.updateTable('collections').set({ sort_order: i }).where('id', '=', r.id).execute();
    const i = all.findIndex(r => r.id === input.collectionId), j = input.direction === 'up' ? i - 1 : i + 1;
    if (i < 0) throw new NotFoundError('Collection not found.');
    if (j < 0 || j >= all.length) return { moved: false };
    await tx.updateTable('collections').set({ sort_order: j }).where('id', '=', all[i].id).execute();
    await tx.updateTable('collections').set({ sort_order: i }).where('id', '=', all[j].id).execute();
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: 'collection.reorder', entityType: 'collections', entityId: input.collectionId, metadata: { swapped_with: all[j].id, direction: input.direction } });
    return { moved: true };
  });
}

export async function setCollectionMember(db: Db, actor: StaffPrincipal, input: { collectionId: string; productId: string; member: boolean }, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  return db.transaction().execute(async tx => {
    const c = await tx.selectFrom('collections').select(['id', 'is_active']).where('id', '=', input.collectionId).forUpdate().executeTakeFirst();
    if (!c) throw new NotFoundError('Collection not found.');
    if (!(await tx.selectFrom('products').select('id').where('id', '=', input.productId).executeTakeFirst())) throw new NotFoundError('Product not found.');
    const cur = await tx.selectFrom('collection_products').select('position').where('collection_id', '=', c.id).where('product_id', '=', input.productId).executeTakeFirst();
    if (!!cur === input.member) return { changed: false };
    if (input.member) {
      const { max } = await tx.selectFrom('collection_products').select(sql<number>`coalesce(max(position), -1)::int`.as('max')).where('collection_id', '=', c.id).executeTakeFirstOrThrow();
      await tx.insertInto('collection_products').values({ collection_id: c.id, product_id: input.productId, position: max + 1 }).execute();
    } else {
      await tx.deleteFrom('collection_products').where('collection_id', '=', c.id).where('product_id', '=', input.productId).execute();
    }
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: input.member ? 'collection.add' : 'collection.remove', entityType: 'collections', entityId: c.id,
      before: { member: !!cur, position: cur?.position ?? null }, after: { member: input.member }, metadata: { product_id: input.productId } });
    return { changed: true };
  });
}

export async function moveCollectionMember(db: Db, actor: StaffPrincipal, input: { collectionId: string; productId: string; direction: 'up' | 'down' }, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  return db.transaction().execute(async tx => {
    const rows = await tx.selectFrom('collection_products').select(['product_id', 'position']).where('collection_id', '=', input.collectionId)
      .orderBy('position').orderBy('product_id').forUpdate().execute();
    return swapPositions(tx, rows.map(r => r.product_id), input.productId, input.direction,
      (id, pos) => tx.updateTable('collection_products').set({ position: pos }).where('collection_id', '=', input.collectionId).where('product_id', '=', id).execute(),
      other => recordAudit(tx, { ...staffAudit(actor, ctx), action: 'collection.reorder_product', entityType: 'collections', entityId: input.collectionId,
        metadata: { product_id: input.productId, swapped_with: other, direction: input.direction } }));
  });
}

// ---------------------------------------------------------------- "Complete the look" (product_relations, styled_with)
export async function listRelated(db: Db, actor: StaffPrincipal, productId: string) {
  requirePermission(actor, 'products.read');
  const related = await db.selectFrom('product_relations as r').innerJoin('products as p', 'p.id', 'r.related_id')
    .select(['p.id', 'p.sku', 'p.name', 'p.status', 'r.position']).where('r.product_id', '=', productId).where('r.kind', '=', 'styled_with')
    .orderBy('r.position').orderBy('p.id').execute();
  const candidates = can(actor, 'products.write')
    ? await db.selectFrom('products').select(['id', 'sku', 'name']).where('status', '!=', 'archived').where('id', '!=', productId)
        .where('id', 'not in', db.selectFrom('product_relations').select('related_id').where('product_id', '=', productId).where('kind', '=', 'styled_with'))
        .orderBy('sku').execute()
    : [];
  return { related, candidates, max: MAX_RELATED };
}

export async function setRelated(db: Db, actor: StaffPrincipal, input: { productId: string; relatedId: string; linked: boolean }, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  if (input.productId === input.relatedId) throw new DomainError('invalid', 'A product cannot be linked to itself.');
  return db.transaction().execute(async tx => {
    const p = await tx.selectFrom('products').select('id').where('id', '=', input.productId).forUpdate().executeTakeFirst();
    if (!p) throw new NotFoundError('Product not found.');
    if (!(await tx.selectFrom('products').select('id').where('id', '=', input.relatedId).executeTakeFirst())) throw new NotFoundError('The linked product was not found.');
    const cur = await tx.selectFrom('product_relations').select('position').where('product_id', '=', p.id).where('related_id', '=', input.relatedId).where('kind', '=', 'styled_with').executeTakeFirst();
    if (!!cur === input.linked) return { changed: false };
    if (input.linked) {
      const agg = await tx.selectFrom('product_relations').select([sql<number>`count(*)::int`.as('n'), sql<number>`coalesce(max(position), -1)::int`.as('max')])
        .where('product_id', '=', p.id).where('kind', '=', 'styled_with').executeTakeFirstOrThrow();
      if (agg.n >= MAX_RELATED) throw new ConflictError(`At most ${MAX_RELATED} products can be linked. Remove one first.`);
      await tx.insertInto('product_relations').values({ product_id: p.id, related_id: input.relatedId, kind: 'styled_with', position: agg.max + 1 }).execute();
    } else {
      await tx.deleteFrom('product_relations').where('product_id', '=', p.id).where('related_id', '=', input.relatedId).where('kind', '=', 'styled_with').execute();
    }
    await recordAudit(tx, { ...staffAudit(actor, ctx), action: input.linked ? 'product.related_add' : 'product.related_remove', entityType: 'products', entityId: p.id,
      metadata: { related_id: input.relatedId } });
    return { changed: true };
  });
}

export async function moveRelated(db: Db, actor: StaffPrincipal, input: { productId: string; relatedId: string; direction: 'up' | 'down' }, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  return db.transaction().execute(async tx => {
    const rows = await tx.selectFrom('product_relations').select(['related_id', 'position']).where('product_id', '=', input.productId).where('kind', '=', 'styled_with')
      .orderBy('position').orderBy('related_id').forUpdate().execute();
    return swapPositions(tx, rows.map(r => r.related_id), input.relatedId, input.direction,
      (id, pos) => tx.updateTable('product_relations').set({ position: pos }).where('product_id', '=', input.productId).where('related_id', '=', id).where('kind', '=', 'styled_with').execute(),
      other => recordAudit(tx, { ...staffAudit(actor, ctx), action: 'product.related_reorder', entityType: 'products', entityId: input.productId,
        metadata: { related_id: input.relatedId, swapped_with: other, direction: input.direction } }));
  });
}

/** Renumbers the list 0..n-1 and swaps the item with its neighbour. */
async function swapPositions(_tx: Tx, ids: string[], id: string, direction: 'up' | 'down', set: (id: string, pos: number) => Promise<unknown>, log: (other: string) => Promise<unknown>) {
  const i = ids.indexOf(id), j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0) throw new NotFoundError('Not found.');
  if (j < 0 || j >= ids.length) return { moved: false };
  [ids[i], ids[j]] = [ids[j], ids[i]];
  for (const [pos, x] of ids.entries()) await set(x, pos);
  await log(ids[i]);
  return { moved: true };
}

// ---------------------------------------------------------------- bulk status
/** Applies setProductStatus to each product (each in its own transaction, with the same checks and audit as one by one).
    A product that cannot take the status (e.g. activating one without a size or image) is reported, not forced. */
export async function bulkSetProductStatus(db: Db, actor: StaffPrincipal, input: BulkProductStatusInput, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  const done: string[] = [], failed: { productId: string; reason: string }[] = [];
  for (const productId of [...new Set(input.productIds)]) {
    try { await setProductStatus(db, actor, { productId, status: input.status }, ctx); done.push(productId); }
    catch (e) { if (e instanceof DomainError) failed.push({ productId, reason: e.message }); else throw e; }
  }
  return { done, failed };
}
