/* Return or exchange at the counter in one step (2026-10-13). The customer hands goods back; they may take other goods
   (any product, size or colour) in the same visit. Everything is worked out on the server and saved in ONE transaction:
   the return, the stock coming back, the replacement bill, and how the difference is settled.
   - Value of what is handed back: what the customer actually paid for those units (the line price with the order's own
     discounts spread over the lines), never a figure sent by the screen.
   - Replacement dearer than the return: the customer pays the difference (the replacement bill takes the returned value as
     one of its tenders). Cheaper: the difference becomes store credit by default; a money refund instead needs
     refunds.create and an in-store order paid in money. Equal: nothing more to settle.
   - Stock: what comes back is restocked at THIS branch, once, unless marked damaged; the replacement leaves this branch.
   - The original bill is never rewritten: the return points at it, and the replacement bill points at the return.
   - The same request sent twice is one return (request key on the return). The order row is locked, so two tills cannot
     return the same units. */
import { recordAudit, sql, type Db, type Tx } from '@kitsyuu/db';
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '@kitsyuu/contracts';
import { can, requireLocation, requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import { alreadyReturned, markPaymentRefunded, refundable, returnSettings } from './returns.ts';
import { completePosSale, quotePosSale, type PosLineInput, type PosTender } from './pos.ts';
import { moveStoreCredit } from './store-credit.ts';
import type { MutationContext } from './staff.ts';

const auditCtx = (c: MutationContext) => ({ ip: c.ip ?? null, userAgent: c.userAgent ?? null, requestId: c.requestId ?? null });
const inr = (paise: number) => `₹${(Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export type ExchangeOutcome = 'collect' | 'store_credit' | 'refund' | 'even';
export interface ExchangeReturnLine { orderItemId: string; qty: number; restock: boolean }

type OrderRow = { id: string; order_number: string; pos_number: string | null; status: string; channel: 'online' | 'retail'; customer_id: string | null; location_id: string | null;
  subtotal_paise: number; total_paise: number; shipping_paise: number; cod_fee_paise: number };
/** What the customer paid for `qty` units of a line: the line price with the order's discounts (and any tax added on top)
    spread in proportion. Delivery and COD fees are not part of it. */
const paidFor = (o: Pick<OrderRow, 'subtotal_paise' | 'total_paise' | 'shipping_paise' | 'cod_fee_paise'>, unitPaise: number, qty: number) =>
  o.subtotal_paise > 0 ? Math.floor(unitPaise * qty * Math.max(0, o.total_paise - o.shipping_paise - o.cod_fee_paise) / o.subtotal_paise) : 0;

async function eligibility(q: Db | Tx, o: OrderRow) {
  const s = await returnSettings(q);
  if (!s.enabled || !s.windowDays) return { ok: false as const, why: 'Returns are not offered (Configuration → Returns): all sales are final.' };
  if (o.status !== 'delivered') return { ok: false as const, why: o.status === 'cancelled' ? 'This order was cancelled.' : 'A return can be made once the order has been delivered / handed over.' };
  const d = await q.selectFrom('order_status_history').select(sql<Date>`max(created_at)`.as('at')).where('order_id', '=', o.id).where('to_status', '=', 'delivered').executeTakeFirst();
  const until = d?.at ? new Date(new Date(d.at).getTime() + s.windowDays * 86_400_000) : null;
  if (!until || until < new Date()) return { ok: false as const, why: `The ${s.windowDays}-day return window for this order has ended.` };
  return { ok: true as const, why: null };
}
const ORDER_COLS = ['id', 'order_number', 'pos_number', 'status', 'channel', 'customer_id', 'location_id', 'subtotal_paise', 'total_paise', 'shipping_paise', 'cod_fee_paise'] as const;

/** An order as the counter needs it for a return: each line with what can still be returned and what a unit is worth. */
export async function getOrderForCounter(db: Db, actor: StaffPrincipal, orderId: string) {
  requirePermission(actor, 'pos.access'); requirePermission(actor, 'orders.read');
  const o = await db.selectFrom('orders').select([...ORDER_COLS, 'payment_status', 'payment_method', 'created_at', 'contact']).where('id', '=', orderId).executeTakeFirst();
  if (!o) throw new NotFoundError('Order not found.');
  const [lines, taken, elig, returns, loc, customer] = await Promise.all([
    db.selectFrom('order_items').select(['id', 'name', 'size', 'colour', 'sku', 'variant_id', 'qty', 'unit_price_paise', 'line_total_paise', 'image_path']).where('order_id', '=', o.id).orderBy('name').orderBy('id').execute(),
    alreadyReturned(db, o.id), eligibility(db, o as OrderRow),
    db.selectFrom('return_requests').select(['id', 'number', 'status', 'resolution', 'settlement', 'settlement_paise', 'exchange_order_id', 'requested_at']).where('order_id', '=', o.id).orderBy('requested_at', 'desc').execute(),
    o.location_id ? db.selectFrom('locations').select('name').where('id', '=', o.location_id).executeTakeFirst() : Promise.resolve(null),
    o.customer_id ? db.selectFrom('customers').select(['id', 'full_name', 'email', 'phone']).where('id', '=', o.customer_id).executeTakeFirst() : Promise.resolve(null),
  ]);
  return { order: { ...o, location_name: loc?.name ?? null }, customer: customer ?? null, eligible: elig.ok, reason: elig.why, returns,
    lines: lines.map(l => ({ ...l, returned: taken.get(l.id) ?? 0, returnable: Math.max(0, l.qty - (taken.get(l.id) ?? 0)), unitValuePaise: paidFor(o as OrderRow, l.unit_price_paise, 1) })),
    can: { process: can(actor, 'returns.manage'), storeCredit: can(actor, 'store_credit.issue'), refund: can(actor, 'refunds.create') && o.channel === 'retail' } };
}

async function work(q: Db | Tx, actor: StaffPrincipal, o: OrderRow, locationId: string, items: ExchangeReturnLine[], replacements: PosLineInput[]) {
  if (!items.length || items.some(i => !Number.isInteger(i.qty) || i.qty < 1)) throw new DomainError('invalid', 'Choose the items and quantities being returned.');
  if (new Set(items.map(i => i.orderItemId)).size !== items.length) throw new DomainError('invalid', 'Each item can be listed once.');
  const [lines, taken] = await Promise.all([q.selectFrom('order_items').select(['id', 'name', 'size', 'sku', 'variant_id', 'qty', 'unit_price_paise']).where('order_id', '=', o.id).execute(), alreadyReturned(q, o.id)]);
  let valuePaise = 0;
  const picked = items.map(it => {
    const l = lines.find(x => x.id === it.orderItemId);
    if (!l) throw new NotFoundError('One of the items is not part of this order.');
    const left = l.qty - (taken.get(l.id) ?? 0);
    if (it.qty > left) throw new ConflictError(left > 0 ? `Only ${left} of ${l.name} (size ${l.size}) can still be returned.` : `${l.name} (size ${l.size}) was already returned.`);
    const v = paidFor(o, l.unit_price_paise, it.qty); valuePaise += v;
    return { ...it, line: l, valuePaise: v };
  });
  const replacement = replacements.length ? await quotePosSale(q as Db, actor, { locationId, lines: replacements, customerId: o.customer_id, discount: null }) : null;
  const replacementPaise = replacement?.totals.totalPaise ?? 0;
  return { picked, valuePaise, replacement, replacementPaise, duePaise: Math.max(0, replacementPaise - valuePaise), surplusPaise: Math.max(0, valuePaise - replacementPaise) };
}

/** What the exchange comes to, before anything is saved: shown to the customer as Collect / Store credit / Refund / Even. */
export async function quoteCounterExchange(db: Db, actor: StaffPrincipal, input: { orderId: string; locationId: string; items: ExchangeReturnLine[]; replacements: PosLineInput[] }) {
  requirePermission(actor, 'returns.manage');
  // 2026-10-14: the goods come back into, and the replacement leaves, the branch the counter is at: it must be one of the
  // staff member's branches. The original sale may be from any branch or the website (a customer may return anywhere).
  requireLocation(actor, input.locationId);
  const o = await db.selectFrom('orders').select([...ORDER_COLS]).where('id', '=', input.orderId).executeTakeFirst() as OrderRow | undefined;
  if (!o) throw new NotFoundError('Order not found.');
  const elig = await eligibility(db, o);
  if (!elig.ok) throw new ConflictError(elig.why);
  const w = await work(db, actor, o, input.locationId, input.items, input.replacements);
  return { returnValuePaise: w.valuePaise, replacementPaise: w.replacementPaise, duePaise: w.duePaise, surplusPaise: w.surplusPaise,
    outcome: (w.duePaise > 0 ? 'collect' : w.surplusPaise > 0 ? 'store_credit' : 'even') as ExchangeOutcome,
    problems: w.replacement?.problems ?? [], replacement: w.replacement ? { lines: w.replacement.lines.map(l => ({ variantId: l.variantId, name: l.name, size: l.size, qty: l.qty, lineTotalPaise: l.lineTotalPaise })), bill: w.replacement.bill } : null,
    storeCreditNeedsCustomer: w.surplusPaise > 0 && !o.customer_id };
}

export interface CounterExchangeInput {
  sessionId: string; orderId: string; items: ExchangeReturnLine[]; reasonCode: string; note: string | null;
  replacements: PosLineInput[];
  /** When the shop owes the difference: store credit (the default) or a money refund. */
  surplus?: 'store_credit' | 'refund';
  /** When the customer owes the difference: how they pay it. */
  tenders?: PosTender[] | null;
  /** The figures the cashier showed; the request is refused if the server works out anything else. */
  expected: { returnValuePaise: number; replacementPaise: number };
  key: string;
}

export async function settleCounterExchange(db: Db, actor: StaffPrincipal, input: CounterExchangeInput, ctx: MutationContext) {
  requirePermission(actor, 'returns.manage');
  if (input.replacements.length) requirePermission(actor, 'pos.sell');
  if (!/^[A-Za-z0-9_-]{16,60}$/.test(input.key ?? '')) throw new DomainError('invalid', 'Missing request key: reload the page and try again.');
  const reason = await db.selectFrom('return_reasons').select('code').where('code', '=', input.reasonCode).where('is_active', '=', true).executeTakeFirst();
  if (!reason) throw new DomainError('invalid', 'Choose the reason for the return.');
  const rkey = `cx:${input.key}`;
  try {
    return await db.transaction().execute(async tx => {
      // Locks, always in this order: the till's session, then the original order. A second request for the same order waits here.
      const s = await tx.selectFrom('pos_sessions as s').innerJoin('locations as l', 'l.id', 's.location_id').select(['s.id', 's.number', 's.staff_id', 's.status', 's.location_id', 'l.name as location_name'])
        .where('s.id', '=', input.sessionId).forUpdate('s').executeTakeFirst();
      if (!s || s.staff_id !== actor.staffId || s.status !== 'open') throw new ConflictError('Your cashier session is not open: open a session to take a return at the counter.');
      requireLocation(actor, s.location_id);   // 2026-10-14
      const o = await tx.selectFrom('orders').select([...ORDER_COLS]).where('id', '=', input.orderId).forUpdate().executeTakeFirst() as OrderRow | undefined;
      if (!o) throw new NotFoundError('Order not found.');
      const prior = await tx.selectFrom('return_requests').select(['id', 'number', 'order_id', 'settlement', 'settlement_paise', 'exchange_order_id']).where('idempotency_key', '=', rkey).executeTakeFirst();
      if (prior) {
        if (prior.order_id !== o.id) throw new ConflictError('This request was already used for another order.');
        return { returnId: prior.id, returnNumber: prior.number, outcome: prior.settlement as ExchangeOutcome, amountPaise: prior.settlement_paise ?? 0, replacementOrderId: prior.exchange_order_id, replay: true };
      }
      const elig = await eligibility(tx, o);
      if (!elig.ok) throw new ConflictError(elig.why);
      const w = await work(tx, actor, o, s.location_id, input.items, input.replacements);
      if (w.valuePaise !== input.expected.returnValuePaise || w.replacementPaise !== input.expected.replacementPaise)
        throw new ConflictError(`The amounts changed (return ${inr(w.valuePaise)}, replacement ${inr(w.replacementPaise)}). Check them with the customer and confirm again.`);
      const surplusAs = w.surplusPaise > 0 ? (input.surplus ?? 'store_credit') : null;
      if (surplusAs === 'store_credit') {
        requirePermission(actor, 'store_credit.issue');
        if (!o.customer_id) throw new ConflictError('Store credit needs a customer account: this order has none. Refund the difference instead, or have the customer choose a replacement of equal or higher value.');
      }
      if (surplusAs === 'refund') {
        requirePermission(actor, 'refunds.create');
        if (o.channel !== 'retail') throw new ForbiddenError('An online order is not refunded in money at the counter: give store credit, or refund it under Returns & refunds.');
      }
      const allRestock = w.picked.every(p => p.restock);
      const ret = await tx.insertInto('return_requests').values({ order_id: o.id, customer_id: o.customer_id, reason_code: input.reasonCode, description: input.note?.trim().slice(0, 2000) || null,
        status: 'completed', resolution: input.replacements.length ? 'exchange' : 'refund', received_at: sql<Date>`now()`, completed_at: sql<Date>`now()`,
        inspection_result: allRestock ? 'ok' : 'damaged', refund_amount_paise: surplusAs === 'refund' ? w.surplusPaise : null, idempotency_key: rkey } as never).returning(['id', 'number']).executeTakeFirstOrThrow();
      await tx.insertInto('return_items').values(w.picked.map(p => ({ return_id: ret.id, order_item_id: p.orderItemId, qty: p.qty, restock: p.restock, restocked_qty: p.restock && p.line.variant_id ? p.qty : 0 }))).execute();
      await tx.insertInto('return_events').values({ return_id: ret.id, from_status: null, to_status: 'completed', actor_type: 'staff', staff_user_id: actor.staffId,
        note: `Taken at the counter, ${s.location_name} (session ${s.number}), for ${o.pos_number ?? o.order_number}: ${w.picked.map(p => `${p.qty} × ${p.line.name} ${p.line.size}${p.restock ? '' : ' (damaged, not restocked)'}`).join(', ')}`.slice(0, 1000) } as never).execute();
      // Stock back into THIS branch, once, through the ledger; damaged goods are not put back on sale.
      for (const p of w.picked) if (p.restock && p.line.variant_id)
        await sql`select public.adjust_location_stock(${p.line.variant_id}::uuid, ${s.location_id}::uuid, ${p.qty}::int, 'return', ${actor.staffId}::uuid, ${`Return ${ret.number} of ${o.pos_number ?? o.order_number}`}::text, null)`.execute(tx);

      // The replacement bill: a normal POS sale at this branch, with the returned value as one of its tenders.
      let replacement: Awaited<ReturnType<typeof completePosSale>> | null = null;
      if (input.replacements.length) {
        if (w.replacement!.problems.length) throw new ConflictError(w.replacement!.problems.join(' '));
        if (w.duePaise > 0 && !(input.tenders?.length)) throw new DomainError('invalid', `Collect ${inr(w.duePaise)}: choose how the customer pays the difference.`);
        if (w.duePaise === 0 && input.tenders?.length) throw new DomainError('invalid', 'Nothing more is due on this exchange: remove the payment.');
        replacement = await completePosSale(db, actor, { sessionId: s.id, idempotencyKey: input.key, lines: input.replacements, customerId: o.customer_id, discount: null,
          payment: { method: 'cash', tenderedPaise: 0 }, tenders: w.duePaise > 0 ? input.tenders : null, expectedTotalPaise: w.replacementPaise }, ctx, { tx, exchange: { returnId: ret.id, valuePaise: w.valuePaise } });
      }
      // What the shop still owes for the goods handed back.
      let refunded = 0;
      if (surplusAs === 'store_credit') {
        await moveStoreCredit(tx, { customerId: o.customer_id!, amountPaise: w.surplusPaise, kind: 'return', reason: `Return ${ret.number} of ${o.pos_number ?? o.order_number}`, key: rkey, orderId: o.id, returnId: ret.id, staffId: actor.staffId });
      } else if (surplusAs === 'refund') {
        // Money goes back against the money that was paid for this order, oldest payment first, never more than is left on it.
        const money = (await refundable(tx, o.id)).filter(p => p.provider === 'pos' && p.left > 0);
        let left = w.surplusPaise;
        for (const p of money) {
          if (left <= 0) break;
          const amount = Math.min(left, p.left);
          await tx.insertInto('refunds').values({ payment_id: p.id, order_id: o.id, return_id: ret.id, amount_paise: amount, reason: `Return ${ret.number} at the counter`, status: 'processed', method: 'manual',
            reference: `RETURN ${ret.number}`, requested_by: actor.staffId, processed_at: sql<Date>`now()`, processed_by: actor.staffId } as never).execute();
          await markPaymentRefunded(tx, o.id, p.id);
          left -= amount; refunded += amount;
        }
        if (left > 0) throw new ConflictError(`Only ${inr(refunded)} of this order was paid in money that can be refunded here: give the difference as store credit instead.`);
      }
      const outcome: ExchangeOutcome = w.duePaise > 0 ? 'collect' : surplusAs ?? 'even', amountPaise = w.duePaise > 0 ? w.duePaise : w.surplusPaise;
      await tx.updateTable('return_requests').set({ settlement: outcome, settlement_paise: amountPaise, exchange_order_id: replacement?.orderId ?? null }).where('id', '=', ret.id).execute();
      await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'pos.exchange', entityType: 'return_requests', entityId: ret.id,
        after: { return_number: ret.number, order_number: o.order_number, pos_number: o.pos_number, outcome, amount_paise: amountPaise, replacement_pos_number: replacement?.posNumber ?? null },
        metadata: { reason: input.reasonCode, note: input.note?.trim() || null, session: s.number, location_id: s.location_id, return_value_paise: w.valuePaise, replacement_paise: w.replacementPaise,
          items: w.picked.map(p => ({ order_item_id: p.orderItemId, qty: p.qty, restock: p.restock, value_paise: p.valuePaise })) }, ...auditCtx(ctx) });
      return { returnId: ret.id, returnNumber: ret.number, outcome, amountPaise, replacementOrderId: replacement?.orderId ?? null, replacementPosNumber: replacement?.posNumber ?? null, changePaise: replacement?.changePaise ?? 0, replay: false };
    });
  } catch (e) {
    if ((e as { code?: string })?.code === '23514') throw new ConflictError('Part of the replacement just sold out at this branch. Check the stock and try again.');
    throw e;
  }
}
