/* Product images. Uploads are validated by their CONTENT (magic bytes), not their name or declared type: only JPEG,
   PNG and WebP are accepted, at most 5 MB. Every upload is decoded and re-encoded by sharp to WebP (which also drops
   metadata such as EXIF/GPS and anything appended to the file), capped at 2400 px, and stored under a random name in
   the existing product-images bucket. The database row + audit record are written in one transaction; if that fails
   the uploaded object is removed again. */
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { recordAudit, sql, type Db, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, MAX_IMAGE_BYTES, NotFoundError } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { ObjectStorage } from './storage.ts';
import type { MutationContext } from './staff.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const MAX_EDGE = 2400;

/** Detects the real image type from the first bytes. */
export function sniffImageType(b: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** Validates and re-encodes an uploaded image. Throws a DomainError with a message the staff member can act on. */
export async function processImage(bytes: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  if (!bytes.length) throw new DomainError('invalid', 'Choose an image file.');
  if (bytes.length > MAX_IMAGE_BYTES) throw new DomainError('invalid', 'The image is larger than 5 MB.');
  if (!sniffImageType(bytes)) throw new DomainError('invalid', 'Only JPEG, PNG or WebP images can be uploaded (checked from the file content).');
  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: 50_000_000, failOn: 'error' })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    if (data.length > MAX_IMAGE_BYTES) throw new DomainError('invalid', 'The image is still larger than 5 MB after conversion. Use a smaller image.');
    return { data, width: info.width, height: info.height };
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError('invalid', 'The file could not be read as an image.');
  }
}

export async function uploadProductImage(db: Db, storage: ObjectStorage, actor: StaffPrincipal, input: { productId: string; alt: string }, bytes: Buffer, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  if (!(await db.selectFrom('products').select('id').where('id', '=', input.productId).executeTakeFirst())) throw new NotFoundError('Product not found.');
  const img = await processImage(bytes);
  const storagePath = `products/${input.productId}-${randomBytes(8).toString('hex')}.webp`;
  await storage.put(storagePath, img.data, 'image/webp');
  try {
    return await db.transaction().execute(async tx => {
      await tx.selectFrom('products').select('id').where('id', '=', input.productId).forUpdate().executeTakeFirstOrThrow();
      const agg = await tx.selectFrom('product_images').select([sql<number>`coalesce(max(sort_order), -1)::int`.as('max'), sql<number>`(count(*) filter (where is_primary))::int`.as('primaries')])
        .where('product_id', '=', input.productId).executeTakeFirstOrThrow();
      const row = { product_id: input.productId, storage_path: storagePath, width: img.width, height: img.height, alt: input.alt, is_primary: agg.primaries === 0, sort_order: agg.max + 1 };
      const created = await tx.insertInto('product_images').values(row).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.image_add', entityType: 'product_images', entityId: created.id,
        after: row, metadata: { product_id: input.productId, bytes: img.data.length }, ...auditCtx(ctx) });
      return { imageId: created.id, storagePath, isPrimary: row.is_primary, width: img.width, height: img.height };
    });
  } catch (e) {
    await storage.remove(storagePath).catch(() => {});                  // no orphaned object when the database step fails
    throw e;
  }
}

async function lockImage(tx: Tx, imageId: string) {
  const img = await tx.selectFrom('product_images').select(['id', 'product_id', 'storage_path', 'alt', 'is_primary', 'sort_order']).where('id', '=', imageId).executeTakeFirst();
  if (!img) throw new NotFoundError('Image not found.');
  // Lock the product's images together, in a stable order, so concurrent primary/order changes cannot interleave.
  const all = await tx.selectFrom('product_images').select(['id', 'storage_path', 'is_primary', 'sort_order']).where('product_id', '=', img.product_id).orderBy('sort_order').orderBy('id').forUpdate().execute();
  return { img, all };
}

export async function setPrimaryImage(db: Db, actor: StaffPrincipal, imageId: string, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  return db.transaction().execute(async tx => {
    const { img, all } = await lockImage(tx, imageId);
    const prev = all.find(i => i.is_primary);
    if (prev?.id === img.id) return { changed: false };
    await tx.updateTable('product_images').set({ is_primary: false }).where('product_id', '=', img.product_id).where('is_primary', '=', true).execute();
    await tx.updateTable('product_images').set({ is_primary: true }).where('id', '=', img.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.image_primary', entityType: 'product_images', entityId: img.id,
      before: { primary: prev?.storage_path ?? null }, after: { primary: img.storage_path }, metadata: { product_id: img.product_id }, ...auditCtx(ctx) });
    return { changed: true };
  });
}

export async function updateImageAlt(db: Db, actor: StaffPrincipal, input: { imageId: string; alt: string }, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  return db.transaction().execute(async tx => {
    const { img } = await lockImage(tx, input.imageId);
    if (img.alt === input.alt) return { changed: false };
    await tx.updateTable('product_images').set({ alt: input.alt }).where('id', '=', img.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.image_update', entityType: 'product_images', entityId: img.id,
      before: { alt: img.alt }, after: { alt: input.alt }, metadata: { product_id: img.product_id }, ...auditCtx(ctx) });
    return { changed: true };
  });
}

export async function moveImage(db: Db, actor: StaffPrincipal, input: { imageId: string; direction: 'up' | 'down' }, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  return db.transaction().execute(async tx => {
    const { all } = await lockImage(tx, input.imageId);
    const i = all.findIndex(x => x.id === input.imageId), j = input.direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= all.length) return { moved: false };
    const [a, b] = [all[i], all[j]];
    await tx.updateTable('product_images').set({ sort_order: b.sort_order }).where('id', '=', a.id).execute();
    await tx.updateTable('product_images').set({ sort_order: a.sort_order }).where('id', '=', b.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.image_reorder', entityType: 'product_images', entityId: a.id,
      before: { sort_order: a.sort_order }, after: { sort_order: b.sort_order }, metadata: { swapped_with: b.id }, ...auditCtx(ctx) });
    return { moved: true };
  });
}

/** Removes an image (row in the transaction, file after commit). The last image of an ACTIVE product cannot be
    removed; removing the primary image promotes the next one. */
export async function removeImage(db: Db, storage: ObjectStorage, actor: StaffPrincipal, imageId: string, ctx: MutationContext) {
  requirePermission(actor, 'products.write');
  const res = await db.transaction().execute(async tx => {
    const { img, all } = await lockImage(tx, imageId);
    const product = await tx.selectFrom('products').select('status').where('id', '=', img.product_id).forUpdate().executeTakeFirstOrThrow();
    if (all.length === 1 && product.status === 'active') throw new ConflictError('An active product needs an image. Upload another image or deactivate the product first.');
    await tx.deleteFrom('product_images').where('id', '=', img.id).execute();
    const next = img.is_primary ? all.find(x => x.id !== img.id) : undefined;
    if (next) await tx.updateTable('product_images').set({ is_primary: true }).where('id', '=', next.id).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'product.image_remove', entityType: 'product_images', entityId: img.id,
      before: { storage_path: img.storage_path, alt: img.alt, is_primary: img.is_primary }, metadata: { product_id: img.product_id, new_primary: next?.storage_path ?? null }, ...auditCtx(ctx) });
    return { storagePath: img.storage_path };
  });
  // The row is gone; remove the file. A failure here leaves only an unreferenced file (logged), never a broken image.
  await storage.remove(res.storagePath).catch(e => console.error('[images] could not remove stored file', res.storagePath, e?.message));
  return { removed: true };
}
