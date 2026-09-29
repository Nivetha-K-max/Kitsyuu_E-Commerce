/* The top bar's "needs attention" list (read-only). Each count is shown only to staff who hold the permission for the
   page it links to, and every count comes from a rule that already exists elsewhere (low stock = v_low_stock, payment
   exceptions = listPaymentExceptions, reviews waiting = status pending, locked sign-ins = the login throttle settings).
   Nothing here is estimated or new business logic. */
import { sql, type Db } from '@kitsyuu/db';
import { can, type StaffPrincipal } from '@kitsyuu/auth';
import { listPaymentExceptions } from './payments-admin.ts';

export interface AttentionItem { key: string; label: string; count: number; href: string; icon: string }

const n = sql<number>`count(*)::int`;

export async function attentionSummary(db: Db, actor: StaffPrincipal): Promise<AttentionItem[]> {
  const jobs: Promise<AttentionItem | null>[] = [];
  if (can(actor, 'orders.read')) jobs.push(db.selectFrom('orders').select(n.as('n')).where('status', 'in', ['paid', 'processing']).executeTakeFirstOrThrow()
    .then(r => ({ key: 'to_ship', label: 'Orders to pack and ship', count: r.n, href: '/orders?status=open', icon: 'orders' })));
  if (can(actor, 'inventory.read')) jobs.push(db.selectFrom('v_low_stock').select(n.as('n')).executeTakeFirstOrThrow()
    .then(r => ({ key: 'low_stock', label: 'Sizes low or out of stock', count: r.n, href: '/inventory?status=attention', icon: 'inventory' })));
  if (can(actor, 'billing.read')) jobs.push(listPaymentExceptions(db)
    .then(rows => ({ key: 'payment_exceptions', label: 'Payment exceptions', count: rows.filter(e => !e.manualRefund).length, href: '/payments?view=exceptions', icon: 'payments' })));
  if (can(actor, 'reviews.read')) jobs.push(db.selectFrom('reviews').select(n.as('n')).where('status', '=', 'pending').executeTakeFirstOrThrow()
    .then(r => ({ key: 'reviews', label: 'Reviews waiting for approval', count: r.n, href: '/reviews?status=pending', icon: 'reviews' })));
  if (can(actor, 'system.read')) jobs.push((async () => {
    const s = await db.selectFrom('settings').select(['key', 'value']).where('key', 'in', ['auth.login_max_failures', 'auth.login_window_minutes']).execute();
    const v = (k: string, d: number) => { const x = Number(s.find(r => r.key === k)?.value); return Number.isFinite(x) && x > 0 ? x : d; };
    const locked = await db.selectFrom('auth_attempts').select(['realm', 'email'])
      .where('succeeded', '=', false).where(sql<boolean>`failure_reason is distinct from 'unverified'`)
      .where(sql<boolean>`attempted_at > now() - make_interval(mins => ${v('auth.login_window_minutes', 15)})`)
      .groupBy(['realm', 'email']).having(sql<number>`count(*)`, '>=', v('auth.login_max_failures', 5)).execute();
    return { key: 'locked', label: 'Sign-ins locked after failures', count: locked.length, href: '/system', icon: 'roles' };
  })());
  return (await Promise.all(jobs)).filter((i): i is AttentionItem => !!i && i.count > 0);
}
