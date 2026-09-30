/* M12: customer reviews and ratings.
   Decided: only customers who bought the item may review it; staff approve every review (and its photos) before anyone
   else sees it; photos are allowed. Not decided: whether "bought" means paid or delivered — the setting
   reviews.eligibility ('paid' | 'delivered') is written from the admin, and while it is unset no review can be written.
   One review per purchased order line. Photos are re-encoded to WebP (metadata such as GPS removed) and stored in the
   database; they are served only by the apps, after the approval check. */
import sharp from 'sharp';
import { recordAudit, sql, type Db, type OrderStatus, type Queryable } from '@kitsyuu/db';
import { ConflictError, DomainError, ForbiddenError, NotFoundError, type SubmitReviewInput } from '@kitsyuu/contracts';
import { requirePermission, type CustomerPrincipal, type RequestContext, type StaffPrincipal } from '@kitsyuu/auth';
import { sniffImageType } from './images.ts';
import { raiseAlertSafely } from './alerts.ts';
import type { MutationContext } from './staff.ts';

export const REVIEW_ELIGIBILITY_KEY = 'reviews.eligibility';
/** Technical limits (not business rules): photo count, upload size, stored edge. */
export const REVIEW_MAX_PHOTOS = 3;
export const REVIEW_PHOTO_MAX_UPLOAD = 5 * 1024 * 1024;
const REVIEW_PHOTO_EDGE = 1600;
const REVIEW_PAGE_SIZE = 20;

export type ReviewEligibility = 'paid' | 'delivered' | null;
/** Order statuses that count as "bought" for each setting value. */
const ELIGIBLE_STATUSES: Record<'paid' | 'delivered', readonly OrderStatus[]> = {
  paid: ['paid', 'processing', 'shipped', 'delivered'],
  delivered: ['delivered'],
};

export async function reviewEligibility(q: Queryable): Promise<ReviewEligibility> {
  const r = await q.selectFrom('settings').select('value').where('key', '=', REVIEW_ELIGIBILITY_KEY).executeTakeFirst();
  return r?.value === 'paid' || r?.value === 'delivered' ? r.value : null;
}

// ---------------------------------------------------------------- customer side (website)
/** The customer's purchased order lines that can be reviewed now, and the reviews they already wrote. */
export async function customerReviewState(db: Db, p: CustomerPrincipal) {
  const eligibility = await reviewEligibility(db);
  const reviews = await db.selectFrom('reviews as r').innerJoin('products as pr', 'pr.id', 'r.product_id')
    .select(['r.id', 'r.order_item_id', 'r.product_id', 'pr.name as product_name', 'r.rating', 'r.title', 'r.status', 'r.created_at'])
    .where('r.customer_id', '=', p.customerId).orderBy('r.created_at', 'desc').execute();
  const reviewable = eligibility
    ? await db.selectFrom('order_items as i').innerJoin('orders as o', 'o.id', 'i.order_id')
        .select(['i.id', 'i.product_id', 'i.name', 'i.size', 'o.order_number', 'o.created_at'])
        .where('o.customer_id', '=', p.customerId).where('o.status', 'in', [...ELIGIBLE_STATUSES[eligibility]])
        .where('i.product_id', 'is not', null)
        .where('i.id', 'not in', db.selectFrom('reviews').select('order_item_id').where('customer_id', '=', p.customerId))
        .orderBy('o.created_at', 'desc').execute()
    : [];
  return { eligibility, reviews, reviewable };
}

export type ReviewPhotoUpload = { bytes: Buffer };
export async function processReviewPhoto(bytes: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  if (!bytes.length) throw new DomainError('invalid', 'One of the photos is empty.');
  if (bytes.length > REVIEW_PHOTO_MAX_UPLOAD) throw new DomainError('invalid', 'Each photo must be under 5 MB.');
  if (!sniffImageType(bytes)) throw new DomainError('invalid', 'Photos must be JPEG, PNG or WebP images.');
  try {
    // .rotate() applies the camera orientation; sharp drops EXIF/GPS metadata unless asked to keep it.
    const { data, info } = await sharp(bytes, { limitInputPixels: 50_000_000, failOn: 'error' }).rotate()
      .resize({ width: REVIEW_PHOTO_EDGE, height: REVIEW_PHOTO_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 }).toBuffer({ resolveWithObject: true });
    if (data.length > 2 * 1024 * 1024) throw new DomainError('invalid', 'A photo is too detailed to store. Use a smaller image.');
    return { data, width: info.width, height: info.height };
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError('invalid', 'One of the files could not be read as an image.');
  }
}

/** A customer submits a review for one order line they bought. It is pending until staff approve it. */
export async function submitReview(db: Db, p: CustomerPrincipal, input: SubmitReviewInput, photos: ReviewPhotoUpload[], ctx: RequestContext) {
  if (photos.length > REVIEW_MAX_PHOTOS) throw new DomainError('invalid', `Add at most ${REVIEW_MAX_PHOTOS} photos.`);
  const processed: { data: Buffer; width: number; height: number }[] = [];
  for (const ph of photos) processed.push(await processReviewPhoto(ph.bytes));       // before the transaction: CPU work
  const eligibility = await reviewEligibility(db);
  if (!eligibility) throw new ForbiddenError('Reviews are not open yet.');
  const created = await db.transaction().execute(async tx => {
    const line = await tx.selectFrom('order_items').select(['id', 'product_id', 'order_id']).where('id', '=', input.orderItemId).executeTakeFirst();
    // Lock the order row (its status decides eligibility). The website role may not lock order_items, and the unique
    // order_item_id constraint already stops a second review of the same line.
    const order = line && await tx.selectFrom('orders').select(['customer_id', 'status']).where('id', '=', line.order_id).forUpdate().executeTakeFirst();
    const item = line && order ? { id: line.id, product_id: line.product_id, customer_id: order.customer_id, status: order.status } : undefined;
    // Someone else's line and a line that does not exist look the same to the customer.
    if (!item || item.customer_id !== p.customerId || !item.product_id) throw new NotFoundError('That purchase was not found.');
    if (!ELIGIBLE_STATUSES[eligibility].includes(item.status))
      throw new ConflictError(eligibility === 'delivered' ? 'You can review this item once it has been delivered.' : 'You can review this item once it has been paid.');
    if (await tx.selectFrom('reviews').select('id').where('order_item_id', '=', item.id).executeTakeFirst()) throw new ConflictError('You have already reviewed this purchase.');
    const r = await tx.insertInto('reviews').values({ product_id: item.product_id, customer_id: p.customerId, order_item_id: item.id, rating: input.rating,
      title: input.title, body: input.body, display_name: input.displayName }).returning('id').executeTakeFirstOrThrow();
    for (const [position, ph] of processed.entries())
      await tx.insertInto('review_photos').values({ review_id: r.id, position, width: ph.width, height: ph.height, bytes: ph.data }).execute();
    await recordAudit(tx, { actorType: 'customer', customerId: p.customerId, action: 'review.submit', entityType: 'reviews', entityId: r.id,
      after: { product_id: item.product_id, rating: input.rating, photos: processed.length }, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
    return { id: r.id };
  });
  await raiseAlertSafely(db, { kind: 'review.submitted', title: 'New review to moderate', entityType: 'reviews', entityId: created.id, link: '/reviews?status=pending',
    dedupeKey: `review.submitted:${created.id}` });
  return created;
}

// ---------------------------------------------------------------- public (store)
/** Approved reviews of one product, newest first, with photo ids (photos are fetched separately). */
export async function approvedReviews(db: Db, productId: string, limit = 50) {
  const rows = await db.selectFrom('reviews').select(['id', 'rating', 'title', 'body', 'display_name', 'created_at'])
    .where('product_id', '=', productId).where('status', '=', 'approved').orderBy('created_at', 'desc').limit(limit).execute();
  const photos = rows.length ? await db.selectFrom('review_photos').select(['id', 'review_id', 'width', 'height']).where('review_id', 'in', rows.map(r => r.id)).orderBy('position').execute() : [];
  return rows.map(r => ({ id: r.id, rating: r.rating, title: r.title, body: r.body, displayName: r.display_name, createdAt: r.created_at as Date,
    photos: photos.filter(x => x.review_id === r.id).map(x => ({ id: x.id, width: x.width, height: x.height })) }));
}

/** Average rating and count of approved reviews per product (for listings, sorting and the rating filter). */
export async function ratingSummary(db: Db): Promise<Map<string, { average: number; count: number }>> {
  const rows = await db.selectFrom('reviews').select(['product_id', sql<number>`round(avg(rating)::numeric, 1)::float8`.as('avg'), sql<number>`count(*)::int`.as('n')])
    .where('status', '=', 'approved').groupBy('product_id').execute();
  return new Map(rows.map(r => [r.product_id, { average: r.avg, count: r.n }]));
}

/** A photo's bytes: for the store only when its review is approved; for staff with reviews.read in any state. */
export async function reviewPhoto(db: Db, photoId: string, staff?: StaffPrincipal) {
  if (staff) requirePermission(staff, 'reviews.read');
  let q = db.selectFrom('review_photos as ph').innerJoin('reviews as r', 'r.id', 'ph.review_id').select(['ph.bytes', 'ph.content_type']).where('ph.id', '=', photoId);
  if (!staff) q = q.where('r.status', '=', 'approved');
  return (await q.executeTakeFirst()) ?? null;
}

// ---------------------------------------------------------------- staff (admin)
export async function listReviews(db: Db, actor: StaffPrincipal, query: { status?: 'pending' | 'approved' | 'rejected'; page: number }) {
  requirePermission(actor, 'reviews.read');
  let q = db.selectFrom('reviews as r').innerJoin('products as p', 'p.id', 'r.product_id').innerJoin('customers as c', 'c.id', 'r.customer_id')
    .leftJoin('staff_users as s', 's.id', 'r.moderated_by')
    .select(['r.id', 'r.rating', 'r.title', 'r.body', 'r.display_name', 'r.status', 'r.moderation_note', 'r.moderated_at', 'r.created_at',
      'p.id as product_id', 'p.name as product_name', 'p.sku', 'c.email as customer_email', 's.email as moderator_email']);
  if (query.status) q = q.where('r.status', '=', query.status);
  const rows = await q.orderBy('r.created_at', query.status === 'pending' ? 'asc' : 'desc').orderBy('r.id')
    .limit(REVIEW_PAGE_SIZE + 1).offset((query.page - 1) * REVIEW_PAGE_SIZE).execute();
  const page = rows.slice(0, REVIEW_PAGE_SIZE);
  const photos = page.length ? await db.selectFrom('review_photos').select(['id', 'review_id', 'width', 'height']).where('review_id', 'in', page.map(r => r.id)).orderBy('position').execute() : [];
  const counts = Object.fromEntries((await db.selectFrom('reviews').select(['status', sql<number>`count(*)::int`.as('n')]).groupBy('status').execute()).map(c => [c.status, c.n]));
  return { rows: page.map(r => ({ ...r, photos: photos.filter(x => x.review_id === r.id) })), hasNext: rows.length > REVIEW_PAGE_SIZE,
    counts: { pending: counts.pending ?? 0, approved: counts.approved ?? 0, rejected: counts.rejected ?? 0 } };
}

/** Approve or reject a review (a published review can be taken down again by rejecting it). A note is required to reject. */
export async function moderateReview(db: Db, actor: StaffPrincipal, input: { reviewId: string; decision: 'approved' | 'rejected'; note: string | null; expectedStatus: string }, ctx: MutationContext) {
  requirePermission(actor, 'reviews.moderate');
  if (input.decision === 'rejected' && !input.note) throw new DomainError('invalid', 'Give a short reason for rejecting.');
  return db.transaction().execute(async tx => {
    const r = await tx.selectFrom('reviews').select(['status', 'product_id']).where('id', '=', input.reviewId).forUpdate().executeTakeFirst();
    if (!r) throw new NotFoundError('Review not found.');
    if (r.status !== input.expectedStatus) throw new ConflictError('This review was moderated by someone else since you opened the page. Reload and try again.');
    if (r.status === input.decision) return { changed: false };
    await tx.updateTable('reviews').set({ status: input.decision, moderation_note: input.note, moderated_by: actor.staffId, moderated_at: sql<Date>`now()` })
      .where('id', '=', input.reviewId).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: `review.${input.decision === 'approved' ? 'approve' : 'reject'}`, entityType: 'reviews',
      entityId: input.reviewId, before: { status: r.status }, after: { status: input.decision, note: input.note }, metadata: { product_id: r.product_id },
      ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
    return { changed: true };
  });
}
