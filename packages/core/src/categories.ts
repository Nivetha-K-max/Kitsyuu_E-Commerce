/* Category administration. Ids follow the existing convention and never change once created ('tops',
   'tops.hoodies'); the storefront uses them in URLs (?category=). Two levels, as the storefront supports.
   Inactive categories are hidden from the storefront by RLS (migration 1300); these rules keep that safe:
   a category cannot be deactivated while an ACTIVE product uses it, a parent cannot be deactivated while it has active
   subcategories, and a subcategory cannot be active under an inactive parent. Every change: permission check → row
   locks → stale check → change + audit record in ONE transaction. */
import { recordAudit, sql, type Db } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError, type CreateCategoryInput, type SetCategoryActiveInput, type UpdateCategoryInput } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });

export async function listCategoryTree(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'categories.read');
  const rows = await db.selectFrom('categories as c')
    .select(['c.id', 'c.label', 'c.parent_id', 'c.sort_order', 'c.is_active', 'c.description',
      sql<number>`(select count(*)::int from public.products p where p.category_id = c.id or p.subcategory_id = c.id)`.as('products'),
      sql<number>`(select count(*)::int from public.products p where (p.category_id = c.id or p.subcategory_id = c.id) and p.status = 'active')`.as('active_products')])
    .orderBy('c.sort_order').orderBy('c.id').execute();
  const parents = rows.filter(r => !r.parent_id);
  return parents.map(p => ({ ...p, children: rows.filter(r => r.parent_id === p.id) }));
}

export async function createCategory(db: Db, actor: StaffPrincipal, input: CreateCategoryInput, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  return db.transaction().execute(async tx => {
    let parentActive = true;
    if (input.parentId) {
      const parent = await tx.selectFrom('categories').select(['id', 'parent_id', 'is_active']).where('id', '=', input.parentId).forUpdate().executeTakeFirst();
      if (!parent) throw new NotFoundError('Parent category not found.');
      if (parent.parent_id) throw new DomainError('invalid', 'Subcategories can only be created under a top-level category.');
      parentActive = parent.is_active;
    }
    const id = input.parentId ? `${input.parentId}.${input.slug}` : input.slug;
    if (await tx.selectFrom('categories').select('id').where('id', '=', id).executeTakeFirst()) throw new ConflictError(`A category with the id "${id}" already exists.`);
    const { max } = await tx.selectFrom('categories').select(sql<number>`coalesce(max(sort_order), -1)::int`.as('max')).executeTakeFirstOrThrow();
    const row = { id, label: input.label, parent_id: input.parentId ?? null, sort_order: max + 1, is_active: parentActive, description: input.description };
    await tx.insertInto('categories').values(row).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'category.create', entityType: 'categories', entityId: id, after: row, ...auditCtx(ctx) });
    return { id, isActive: parentActive };
  });
}

export async function updateCategory(db: Db, actor: StaffPrincipal, input: UpdateCategoryInput, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  return db.transaction().execute(async tx => {
    const c = await tx.selectFrom('categories').select(['label', 'description']).where('id', '=', input.categoryId).forUpdate().executeTakeFirst();
    if (!c) throw new NotFoundError('Category not found.');
    if (c.label !== input.expectedLabel) throw new ConflictError('This category was changed by someone else since you opened the page. Reload and try again.');
    const changed = (['label', 'description'] as const).filter(k => c[k] !== input[k]);
    if (!changed.length) return { changed: 0 };
    await tx.updateTable('categories').set({ label: input.label, description: input.description }).where('id', '=', input.categoryId).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'category.update', entityType: 'categories', entityId: input.categoryId,
      before: Object.fromEntries(changed.map(k => [k, c[k]])), after: Object.fromEntries(changed.map(k => [k, input[k]])), ...auditCtx(ctx) });
    return { changed: changed.length };
  });
}

export async function setCategoryActive(db: Db, actor: StaffPrincipal, input: SetCategoryActiveInput, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  await db.transaction().execute(async tx => {
    const c = await tx.selectFrom('categories').select(['id', 'parent_id', 'is_active']).where('id', '=', input.categoryId).forUpdate().executeTakeFirst();
    if (!c) throw new NotFoundError('Category not found.');
    if (c.is_active !== input.expectedActive) throw new ConflictError('This category was changed by someone else since you opened the page. Reload and try again.');
    if (c.is_active === input.active) return;
    if (!input.active) {
      // The category row is locked FOR UPDATE above; activating a product (or moving an active product into this
      // category) takes FOR SHARE on its category rows, so the two cannot interleave.
      const used = await tx.selectFrom('products').select(sql<number>`count(*)::int`.as('n'))
        .where(eb => eb.or([eb('category_id', '=', c.id), eb('subcategory_id', '=', c.id)])).where('status', '=', 'active').executeTakeFirstOrThrow();
      if (used.n > 0) throw new ConflictError(`${used.n} active product${used.n === 1 ? ' uses' : 's use'} this category. Move or deactivate ${used.n === 1 ? 'it' : 'them'} first.`);
      const kids = await tx.selectFrom('categories').select(sql<number>`count(*)::int`.as('n')).where('parent_id', '=', c.id).where('is_active', '=', true).executeTakeFirstOrThrow();
      if (kids.n > 0) throw new ConflictError('Deactivate its subcategories first.');
    } else if (c.parent_id) {
      const parent = await tx.selectFrom('categories').select('is_active').where('id', '=', c.parent_id).forUpdate().executeTakeFirstOrThrow();
      if (!parent.is_active) throw new ConflictError('Activate the parent category first.');
    }
    await tx.updateTable('categories').set({ is_active: input.active }).where('id', '=', c.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'category.status_update', entityType: 'categories', entityId: c.id,
      before: { is_active: c.is_active }, after: { is_active: input.active }, ...auditCtx(ctx) });
  });
}

/** Swaps the category with its previous/next sibling (same parent). */
export async function moveCategory(db: Db, actor: StaffPrincipal, input: { categoryId: string; direction: 'up' | 'down' }, ctx: MutationContext) {
  requirePermission(actor, 'categories.write');
  return db.transaction().execute(async tx => {
    const c = await tx.selectFrom('categories').select(['id', 'parent_id']).where('id', '=', input.categoryId).executeTakeFirst();
    if (!c) throw new NotFoundError('Category not found.');
    const siblings = await tx.selectFrom('categories').select(['id', 'sort_order'])
      .where(eb => (c.parent_id ? eb('parent_id', '=', c.parent_id) : eb('parent_id', 'is', null)))
      .orderBy('sort_order').orderBy('id').forUpdate().execute();
    const i = siblings.findIndex(s => s.id === c.id), j = input.direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= siblings.length) return { moved: false };
    const [a, b] = [siblings[i], siblings[j]];
    await tx.updateTable('categories').set({ sort_order: b.sort_order }).where('id', '=', a.id).execute();
    await tx.updateTable('categories').set({ sort_order: a.sort_order }).where('id', '=', b.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'category.reorder', entityType: 'categories', entityId: a.id,
      before: { sort_order: a.sort_order }, after: { sort_order: b.sort_order }, metadata: { swapped_with: b.id, direction: input.direction }, ...auditCtx(ctx) });
    return { moved: true };
  });
}
