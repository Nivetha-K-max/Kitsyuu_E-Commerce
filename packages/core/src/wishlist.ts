/* Customer wishlist (M7): saved products of a signed-in customer (wishlists + wishlist_items). A guest's browser wishlist is
   merged in after login. Products that are no longer on sale drop out automatically. Scoped to the signed-in customer. */
import type { Db, Tx } from '@kitsyuu/db';
import { MAX_LINES_PER_REQUEST, wishlistInput } from '@kitsyuu/contracts';
import type { CustomerPrincipal } from '@kitsyuu/auth';

async function wishlistId(tx: Tx, customerId: string): Promise<string> {
  await tx.insertInto('wishlists').values({ customer_id: customerId }).onConflict(oc => oc.column('customer_id').doNothing()).execute();
  return (await tx.selectFrom('wishlists').select('id').where('customer_id', '=', customerId).executeTakeFirstOrThrow()).id;
}

/** Product ids on the customer's wishlist, oldest first (only products on sale: RLS hides the others). */
export async function getWishlist(db: Db, p: CustomerPrincipal): Promise<string[]> {
  const rows = await db.selectFrom('wishlist_items as w').innerJoin('wishlists as l', 'l.id', 'w.wishlist_id').innerJoin('products as pr', 'pr.id', 'w.product_id')
    .select('w.product_id').where('l.customer_id', '=', p.customerId).where('pr.status', '=', 'active')
    .orderBy('w.created_at').orderBy('w.id').execute();
  return rows.map(r => r.product_id);
}

/** Saves or un-saves a product; returns whether it is now saved. */
export async function setWishlisted(db: Db, p: CustomerPrincipal, productId: string, saved: boolean): Promise<boolean> {
  return db.transaction().execute(async tx => {
    const id = await wishlistId(tx, p.customerId);
    if (!saved) { await tx.deleteFrom('wishlist_items').where('wishlist_id', '=', id).where('product_id', '=', productId).execute(); return false; }
    const product = await tx.selectFrom('products').select('id').where('id', '=', productId).where('status', '=', 'active').executeTakeFirst();
    if (!product) return false;
    const has = await tx.selectFrom('wishlist_items').select('id').where('wishlist_id', '=', id).where('product_id', '=', productId).executeTakeFirst();
    if (!has) await tx.insertInto('wishlist_items').values({ wishlist_id: id, product_id: productId }).execute();
    return true;
  });
}

/** Adds a guest (browser) wishlist after login; unknown products are skipped. */
export async function mergeGuestWishlist(db: Db, p: CustomerPrincipal, raw: unknown[]): Promise<{ merged: number; skipped: number }> {
  const ids = [...new Set(raw.slice(0, MAX_LINES_PER_REQUEST).map(x => wishlistInput.safeParse({ productId: x }).data?.productId).filter((x): x is string => !!x))];
  let merged = 0, skipped = raw.length - ids.length;
  if (!ids.length) return { merged, skipped };
  await db.transaction().execute(async tx => {
    const id = await wishlistId(tx, p.customerId);
    const onSale = new Set((await tx.selectFrom('products').select('id').where('id', 'in', ids).where('status', '=', 'active').execute()).map(r => r.id));
    const have = new Set((await tx.selectFrom('wishlist_items').select('product_id').where('wishlist_id', '=', id).execute()).map(r => r.product_id));
    for (const pid of ids) {
      if (!onSale.has(pid)) { skipped++; continue; }
      if (!have.has(pid)) await tx.insertInto('wishlist_items').values({ wishlist_id: id, product_id: pid }).execute();
      merged++;
    }
  });
  return { merged, skipped };
}
