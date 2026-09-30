/* ERP module 8: staff notifications (the notification centre).
   A notification is visible to every staff member who holds its permission, with a read state per person. Each kind can
   be switched off in Settings (alerts.<kind> = 'off'); a kind with no setting is on (internal alerts, not a customer rule).
   Alerts are raised AFTER the business change has committed (raiseAlertSafely): a failed alert is logged and never undoes
   or blocks an order, payment, return or ticket. dedupe_key stops the same event being raised twice. */
import { sql, type Db, type Queryable } from '@kitsyuu/db';
import type { StaffPrincipal } from '@kitsyuu/auth';

export type AlertSeverity = 'info' | 'warning' | 'critical';
export interface AlertKind { label: string; permission: string; severity: AlertSeverity }

/** Every kind the platform raises. The permission decides who sees it (the same permission its ERP page needs). */
export const ALERT_KINDS = {
  'order.placed': { label: 'New order', permission: 'orders.read', severity: 'info' },
  'order.paid': { label: 'Order paid (ready to pack and ship)', permission: 'orders.read', severity: 'info' },
  'payment.failed': { label: 'Payment failed', permission: 'billing.read', severity: 'warning' },
  'payment.issue': { label: 'Payment needs attention', permission: 'billing.read', severity: 'critical' },
  'stock.low': { label: 'Low stock', permission: 'inventory.read', severity: 'warning' },
  'stock.out': { label: 'Out of stock', permission: 'inventory.read', severity: 'critical' },
  'return.requested': { label: 'New return request', permission: 'returns.read', severity: 'info' },
  'refund.failed': { label: 'Refund failed', permission: 'returns.read', severity: 'critical' },
  'support.ticket': { label: 'New support ticket', permission: 'support.read', severity: 'info' },
  'support.reply': { label: 'Customer replied to a ticket', permission: 'support.read', severity: 'info' },
  'review.submitted': { label: 'New review to moderate', permission: 'reviews.read', severity: 'info' },
  'shipment.failed': { label: 'Delivery failed', permission: 'shipping.read', severity: 'warning' },
  'security.locked': { label: 'Sign-ins locked after failures', permission: 'system.read', severity: 'critical' },
} as const satisfies Record<string, AlertKind>;
export type AlertKindCode = keyof typeof ALERT_KINDS;

export interface AlertInput {
  kind: AlertKindCode; title: string; body?: string | null; entityType?: string | null; entityId?: string | null; link?: string | null;
  dedupeKey?: string | null; severity?: AlertSeverity;
}

async function alertEnabled(q: Queryable, kind: AlertKindCode): Promise<boolean> {
  const r = await q.selectFrom('settings').select('value').where('key', '=', `alerts.${kind}`).executeTakeFirst();
  return r?.value !== 'off';
}

/** Records one alert (skipped when its kind is switched off, or when the same dedupe key was already raised). */
export async function raiseStaffAlert(q: Queryable, a: AlertInput): Promise<boolean> {
  const kind = ALERT_KINDS[a.kind];
  if (!kind || !(await alertEnabled(q, a.kind))) return false;
  // Through raise_staff_notification(): insert-only, a repeated dedupe key is skipped (the store role cannot touch the table).
  const r = await sql<{ ok: boolean }>`select public.raise_staff_notification(${a.kind}, ${a.severity ?? kind.severity}, ${a.title.slice(0, 160)},
    ${a.body ? a.body.slice(0, 500) : null}, ${a.entityType ?? null}, ${a.entityId ?? null}, ${a.link ?? null}, ${kind.permission}, ${a.dedupeKey ?? null}) as ok`.execute(q);
  return r.rows[0]?.ok === true;
}

/** For use after a business transaction has committed: an alert problem is logged, never thrown. */
export async function raiseAlertSafely(q: Queryable, a: AlertInput): Promise<void> {
  try { await raiseStaffAlert(q, a); } catch (e) { console.error(`[alerts] could not raise ${a.kind}:`, (e as Error).message); }
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

/** Conditions that are states rather than events (low / out of stock, locked sign-ins) become alerts here, at most once a
    day per size and once an hour per locked email. Run whenever staff open the bell or the notification centre. */
export async function sweepConditionAlerts(db: Db): Promise<void> {
  const day = today();
  const low = await db.selectFrom('v_low_stock').select(['variant_id', 'variant_sku', 'product_name', 'size', 'stock_qty', 'stock_status']).execute();
  for (const r of low) {
    const out = r.stock_status === 'out_of_stock';
    await raiseAlertSafely(db, {
      kind: out ? 'stock.out' : 'stock.low', title: `${out ? 'Out of stock' : 'Low stock'}: ${r.product_name}, size ${r.size}`,
      body: `${r.variant_sku} has ${r.stock_qty} left.`, entityType: 'product_variants', entityId: r.variant_id, link: '/inventory?status=attention',
      dedupeKey: `stock.${out ? 'out' : 'low'}:${r.variant_id}:${day}`,
    });
  }
  const s = await db.selectFrom('settings').select(['key', 'value']).where('key', 'in', ['auth.login_max_failures', 'auth.login_window_minutes']).execute();
  const v = (k: string, d: number) => { const x = Number(s.find(r => r.key === k)?.value); return Number.isFinite(x) && x > 0 ? x : d; };
  const locked = await db.selectFrom('auth_attempts').select(['realm', 'email', sql<number>`count(*)::int`.as('n')])
    .where('succeeded', '=', false).where(sql<boolean>`failure_reason is distinct from 'unverified'`)
    .where(sql<boolean>`attempted_at > now() - make_interval(mins => ${v('auth.login_window_minutes', 15)})`)
    .groupBy(['realm', 'email']).having(sql<number>`count(*)`, '>=', v('auth.login_max_failures', 5)).execute();
  const hour = new Date().toISOString().slice(0, 13);
  for (const l of locked) {
    await raiseAlertSafely(db, {
      kind: 'security.locked', title: `${l.realm === 'staff' ? 'Staff' : 'Customer'} sign-ins locked: ${l.email ?? 'unknown email'}`,
      body: `${l.n} failed sign-ins in the current window.`, link: '/audit/sign-ins', dedupeKey: `security.locked:${l.realm}:${l.email}:${hour}`,
    });
  }
}

/** The sweep at most once every few minutes per server instance (the bell asks on every page change). */
const gs = globalThis as unknown as { __kitsyuuAlertSweep?: number };
export async function sweepConditionAlertsThrottled(db: Db, everyMs = 5 * 60_000): Promise<void> {
  if (gs.__kitsyuuAlertSweep && Date.now() - gs.__kitsyuuAlertSweep < everyMs) return;
  gs.__kitsyuuAlertSweep = Date.now();
  try { await sweepConditionAlerts(db); } catch (e) { console.error('[alerts] sweep failed', (e as Error).message); }
}

export const NOTIFICATION_PAGE_SIZE = 30;
const visible = (actor: StaffPrincipal) => [...actor.permissions];

export async function listStaffNotifications(db: Db, actor: StaffPrincipal, query: { show: 'all' | 'unread'; severity: 'all' | AlertSeverity; page: number }) {
  const perms = visible(actor);
  if (!perms.length) return { rows: [], hasNext: false };
  let q = db.selectFrom('staff_notifications as n')
    .leftJoin('staff_notification_reads as r', join => join.onRef('r.notification_id', '=', 'n.id').on('r.staff_user_id', '=', actor.staffId))
    .select(['n.id', 'n.kind', 'n.severity', 'n.title', 'n.body', 'n.link', 'n.entity_type', 'n.entity_id', 'n.created_at', 'r.read_at'])
    .where('n.permission', 'in', perms);
  if (query.show === 'unread') q = q.where('r.read_at', 'is', null);
  if (query.severity !== 'all') q = q.where('n.severity', '=', query.severity);
  const rows = await q.orderBy('n.created_at', 'desc').orderBy('n.id', 'desc')
    .limit(NOTIFICATION_PAGE_SIZE + 1).offset((query.page - 1) * NOTIFICATION_PAGE_SIZE).execute();
  return { rows: rows.slice(0, NOTIFICATION_PAGE_SIZE).map(r => ({ ...r, id: String(r.id), read: !!r.read_at })), hasNext: rows.length > NOTIFICATION_PAGE_SIZE };
}

export async function unreadNotifications(db: Db, actor: StaffPrincipal, latest = 5) {
  const perms = visible(actor);
  if (!perms.length) return { count: 0, latest: [] };
  const base = db.selectFrom('staff_notifications as n')
    .leftJoin('staff_notification_reads as r', join => join.onRef('r.notification_id', '=', 'n.id').on('r.staff_user_id', '=', actor.staffId))
    .where('n.permission', 'in', perms).where('r.read_at', 'is', null);
  const [c, rows] = await Promise.all([
    base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    base.select(['n.id', 'n.kind', 'n.severity', 'n.title', 'n.link', 'n.created_at']).orderBy('n.created_at', 'desc').limit(latest).execute(),
  ]);
  return { count: c.n, latest: rows.map(r => ({ ...r, id: String(r.id) })) };
}

/** Marks notifications read for this staff member (only ones they are allowed to see). */
export async function markNotificationsRead(db: Db, actor: StaffPrincipal, input: { ids: string[]; all: boolean }): Promise<number> {
  const perms = visible(actor);
  if (!perms.length) return 0;
  let q = db.selectFrom('staff_notifications as n').select('n.id').where('n.permission', 'in', perms)
    .where(eb => eb.not(eb.exists(eb.selectFrom('staff_notification_reads as r').select('r.notification_id')
      .whereRef('r.notification_id', '=', 'n.id').where('r.staff_user_id', '=', actor.staffId))));
  if (!input.all) q = q.where('n.id', 'in', input.ids);
  const rows = await q.limit(5000).execute();
  if (!rows.length) return 0;
  await db.insertInto('staff_notification_reads').values(rows.map(r => ({ notification_id: String(r.id), staff_user_id: actor.staffId })))
    .onConflict(oc => oc.columns(['notification_id', 'staff_user_id']).doNothing()).execute();
  return rows.length;
}
