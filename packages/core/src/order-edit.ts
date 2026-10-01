/* Client change request, second pass: staff edit an order before it ships.

   What can change: each line's size (another size of the same product at the same price) and quantity (0 removes the
   line; at least one line stays), and the delivery address. Nothing is added from outside the order.

   When: an order paid online that is paid or processing, or a cash-on-delivery order that is processing with the cash
   still to collect. Not once it has shipped, has an issued invoice (void it first), or has a refund. The total the page
   showed must still be the order's total (someone else may have edited it meanwhile).

   How the new amounts are worked out, on the server, from the order itself (never from the page):
   - each line keeps the price the customer was charged for it (a size swap keeps it too, since only a size at the same
     price can be chosen);
   - the order's discounts (coupons, automatic discounts) are scaled in proportion to the new item total, never above what
     they were (the same proportional split the invoice uses); the cash-on-delivery discount and the loyalty points used
     stay as they were (refused if they would be more than the items);
   - delivery is re-quoted only when the address changes (same delivery option when it is still available there;
     refused where there is no delivery, and for COD where COD is not allowed); otherwise the delivery charge stays;
   - tax uses the rate recorded on the order; the COD fee stays.
   Money: for an order paid online, a lower total leaves a refund due (made from the order page through the payment
   provider, or recorded as paid outside the platform with its reference); a higher total is refused, because collecting
   an extra payment is not supported. For a COD order the new total is simply what is collected on delivery.
   Stock moves through the ledger in the same transaction (more units: 'sale'; fewer: 'cancel', both against the order, so
   a later cancellation returns exactly what the order holds). Every edit keeps the order before and after, the reason and
   the staff member (order_edits) and is in the audit log. */
import { recordAudit, sql, type Db, type Queryable } from '@kitsyuu/db';
import { ConflictError, DomainError, NotFoundError, type OrderEditInput } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';
import type { DiscountLine, ShippingProvider, ShippingQuote } from './pricing.ts';
import type { PaymentProvider } from './payments/provider.ts';
import { codQuote } from './cod.ts';
import { markPaymentRefunded, refundable } from './returns.ts';
import { raiseAlertSafely } from './alerts.ts';

const auditCtx = (ctx: MutationContext) => ({ ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
const rupees = (p: number) => `₹${(p / 100).toFixed(2)}`;
type Pricing = { tax?: { configured?: boolean; rateBp?: number; inclusive?: boolean }; shipping?: ShippingQuote; discounts?: DiscountLine[]; cod?: { feePaise: number } };

/** Why an order cannot be edited now, or null when it can. */
export async function orderEditBlocker(q: Queryable, orderId: string): Promise<string | null> {
  const o = await q.selectFrom('orders').select(['status', 'payment_method', 'cod_status', 'payment_status']).where('id', '=', orderId).executeTakeFirst();
  if (!o) return 'Order not found.';
  const cod = o.payment_method === 'cod';
  if (cod ? !(o.status === 'processing' && o.cod_status === 'to_collect') : !(o.status === 'paid' || o.status === 'processing'))
    return o.status === 'pending_payment' || o.status === 'payment_failed' ? 'An order waiting for payment cannot be edited: the customer can cancel it and order again.'
      : 'Only an order that has not shipped can be edited.';
  // (partially refunded: a refund made for an earlier edit)
  if (!cod && o.payment_status !== 'paid' && o.payment_status !== 'partially_refunded') return 'Only an order that has been paid can be edited.';
  if (await q.selectFrom('invoices').select('id').where('order_id', '=', orderId).where('status', '=', 'issued').executeTakeFirst())
    return 'This order has an issued invoice. Void the invoice first (Finance), then edit the order and issue a new one.';
  // A refund for any other reason (cancellation money, a return) means the order is no longer a plain paid order.
  if (await q.selectFrom('refunds as r').select('r.id').where('r.order_id', '=', orderId).where('r.status', 'in', ['requested', 'pending', 'processed'])
    .where(eb => eb.not(eb.exists(eb.selectFrom('order_edits as e').select('e.id').whereRef('e.refund_id', '=', 'r.id')))).executeTakeFirst())
    return 'This order has a refund, so it cannot be edited here.';
  if (await q.selectFrom('order_edits').select('id').where('order_id', '=', orderId).where('refund_due_paise', '>', 0).where('refund_id', 'is', null).executeTakeFirst())
    return 'Make the refund due from the last edit before editing again.';
  return null;
}

export async function editOrder(db: Db, actor: StaffPrincipal, input: OrderEditInput, ctx: MutationContext, opts: { shipping: ShippingProvider }) {
  requirePermission(actor, 'orders.edit');
  try {
    const r = await db.transaction().execute(async tx => {
      const locked = await tx.selectFrom('orders').select('id').where('id', '=', input.orderId).forUpdate().executeTakeFirst();
      if (!locked) throw new NotFoundError('Order not found.');
      const o = await tx.selectFrom('orders').selectAll().where('id', '=', input.orderId).executeTakeFirstOrThrow();
      const blocker = await orderEditBlocker(tx, o.id);
      if (blocker) throw new ConflictError(blocker);
      if (o.total_paise !== input.expectedTotalPaise) throw new ConflictError('This order changed since you opened it. Reload it and make your changes again.');

      const items = await tx.selectFrom('order_items').selectAll().where('order_id', '=', o.id).execute();
      const byId = new Map(items.map(i => [i.id, i]));
      if (input.lines.length !== items.length || input.lines.some(l => !byId.has(l.itemId))) throw new ConflictError('The items of this order changed. Reload it and try again.');

      // ---- the new lines
      const variants = await tx.selectFrom('product_variants').select(['id', 'product_id', 'size', 'sku', 'price_paise', 'is_active', 'colour_slug', sql<string | null>`(select av.label from public.attribute_values av where av.attribute_id = 'colour' and av.slug = colour_slug)`.as('colour_label')])
        .where('id', 'in', [...new Set([...input.lines.map(l => l.variantId), ...items.map(i => i.variant_id).filter((v): v is string => !!v)])]).execute();
      const vById = new Map(variants.map(v => [v.id, v]));
      // Third pass: a line can move to another COLOUR and/or size of the same product (same price), checked here and in stock below.
      const next: { item: typeof items[number]; variantId: string; sku: string; size: string; colour: string | null; qty: number }[] = [];
      for (const l of input.lines) {
        const item = byId.get(l.itemId)!;
        if (l.qty === 0) continue;
        if (l.variantId === item.variant_id) { next.push({ item, variantId: l.variantId, sku: item.sku, size: item.size, colour: item.colour, qty: l.qty }); continue; }
        const now = item.variant_id ? vById.get(item.variant_id) : undefined, to = vById.get(l.variantId);
        if (!to || to.product_id !== item.product_id) throw new DomainError('invalid', `Choose another size of ${item.name}.`);
        if (!to.is_active) throw new ConflictError(`Size ${to.size} of ${item.name} is not on sale.`);
        if ((now?.price_paise ?? null) !== (to.price_paise ?? null))
          throw new ConflictError(`Size ${to.size} of ${item.name} has a different price, so it cannot be swapped here.`);
        next.push({ item, variantId: to.id, sku: to.sku, size: to.size, colour: to.colour_slug ? (to.colour_label ?? to.colour_slug) : null, qty: l.qty });
      }
      if (!next.length) throw new ConflictError('An order needs at least one item. To remove everything, cancel the order instead.');
      if (new Set(next.map(n => n.variantId)).size !== next.length) throw new ConflictError('Two lines would be the same size. Change the quantity of one line instead.');

      const newAddress = input.address ? { name: input.address.fullName, phone: input.address.phone, line1: input.address.line1, line2: input.address.line2,
        city: input.address.city, state: input.address.state, pin: input.address.pin, country: 'IN' } : null;
      const linesChanged = next.length !== items.length || next.some(n => n.variantId !== n.item.variant_id || n.qty !== n.item.qty);
      if (!linesChanged && !newAddress) throw new DomainError('invalid', 'Nothing was changed.');

      // ---- the new amounts
      const pricing = (o.pricing ?? {}) as Pricing;
      const subtotal = next.reduce((n, x) => n + x.item.unit_price_paise * x.qty, 0);
      const oldDiscounts = pricing.discounts ?? [];
      const discounts = oldDiscounts.map(d => d.code === 'LOYALTY' || d.code === 'COD' ? d
        : { ...d, amountPaise: Math.min(d.amountPaise, Math.floor(d.amountPaise * subtotal / Math.max(1, o.subtotal_paise))) });
      // Orders from before the discount snapshot existed: scale the order's discount the same way.
      const discount = oldDiscounts.length ? discounts.reduce((n, d) => n + d.amountPaise, 0)
        : Math.min(o.discount_paise, Math.floor(o.discount_paise * subtotal / Math.max(1, o.subtotal_paise)));
      if (discount > subtotal) throw new ConflictError('The points or cash-on-delivery discount on this order would be more than the items left. Cancel the order instead.');

      let shipping = o.shipping_paise, quote: ShippingQuote | null = null;
      const oldShip = (o.shipping_address ?? {}) as Record<string, unknown>;
      if (newAddress) {
        quote = await opts.shipping.quote({ lines: next.map(n => ({ productId: n.item.product_id ?? '', variantId: n.variantId, qty: n.qty, unitPaise: n.item.unit_price_paise,
          lineTotalPaise: n.item.unit_price_paise * n.qty })), subtotalPaise: subtotal,
          shipTo: { state: newAddress.state, pin: newAddress.pin, country: 'IN', deliveryRateId: pricing.shipping?.rateId ?? null } });
        if (quote.unavailable) throw new ConflictError(`New address: ${quote.unavailable}`);
        if (o.payment_method === 'cod' && !(await codQuote(tx, quote, subtotal - discount)).available)
          throw new ConflictError('Cash on delivery is not available at the new address.');
        shipping = quote.amountPaise;
      }
      const t = pricing.tax?.configured ? pricing.tax : null;
      const taxable = subtotal - discount;
      const tax = !t ? 0 : t.inclusive ? Math.round(taxable * (t.rateBp ?? 0) / (10_000 + (t.rateBp ?? 0))) : Math.round(taxable * (t.rateBp ?? 0) / 10_000);
      const total = taxable + shipping + o.cod_fee_paise + (o.prices_include_tax ? 0 : tax);
      const diff = total - o.total_paise;
      if (o.payment_method !== 'cod' && diff > 0)
        throw new ConflictError(`The new total would be ${rupees(total)}, ${rupees(diff)} more than the customer paid. Collecting an extra payment is not supported, so this change cannot be made here.`);
      const refundDue = o.payment_method !== 'cod' && diff < 0 ? -diff : 0;

      // ---- stock (fewer units back first, then more units taken; refused when a size does not have enough)
      const qtyBy = (list: { variantId: string | null; qty: number }[]) => list.reduce((m, x) => (x.variantId ? m.set(x.variantId, (m.get(x.variantId) ?? 0) + x.qty) : m), new Map<string, number>());
      const before = qtyBy(items.map(i => ({ variantId: i.variant_id, qty: i.qty }))), after = qtyBy(next);
      const deltas = [...new Set([...before.keys(), ...after.keys()])].map(v => ({ variantId: v, delta: (after.get(v) ?? 0) - (before.get(v) ?? 0) })).filter(d => d.delta !== 0)
        .sort((a, b) => a.delta - b.delta || a.variantId.localeCompare(b.variantId));
      const stockNote = `Order ${o.order_number} edited`;
      for (const d of deltas.filter(x => x.delta < 0))
        await sql`select public.adjust_stock(${d.variantId}::uuid, ${-d.delta}::int, 'cancel', ${actor.staffId}::uuid, ${stockNote}::text, ${o.id}::uuid)`.execute(tx);
      for (const d of deltas.filter(x => x.delta > 0)) {
        try {
          await sql`select public.adjust_stock(${d.variantId}::uuid, ${-d.delta}::int, 'sale', ${actor.staffId}::uuid, ${stockNote}::text, ${o.id}::uuid)`.execute(tx);
        } catch (e) {
          if ((e as { code?: string }).code === '23514') {
            const v = vById.get(d.variantId);
            throw new ConflictError(v ? `Size ${v.size} is currently unavailable (not enough stock for this change).` : 'A size is currently unavailable (not enough stock for this change).');
          }
          throw e;
        }
      }

      // ---- write
      const kept = new Set(next.map(n => n.item.id));
      const removed = items.filter(i => !kept.has(i.id));
      if (removed.length) await tx.deleteFrom('order_items').where('id', 'in', removed.map(i => i.id)).execute();
      for (const n of next) {
        if (n.variantId === n.item.variant_id && n.qty === n.item.qty) continue;
        await tx.updateTable('order_items').set({ variant_id: n.variantId, sku: n.sku, size: n.size, colour: n.colour, qty: n.qty, line_total_paise: n.item.unit_price_paise * n.qty }).where('id', '=', n.item.id).execute();
      }
      const newPricing: Pricing = { ...pricing, discounts, ...(quote ? { shipping: quote } : {}) };
      // Amount columns are a snapshot everywhere else; this is the one place that changes them, audited below.
      await sql`update public.orders set subtotal_paise = ${subtotal}, discount_paise = ${discount}, shipping_paise = ${shipping}, tax_paise = ${tax},
        total_paise = ${total}, pricing = ${JSON.stringify(newPricing)}::jsonb
        ${newAddress ? sql`, shipping_address = ${JSON.stringify(newAddress)}::jsonb` : sql``} where id = ${o.id}`.execute(tx);

      const snapshot = (lines: { sku: string; size: string; qty: number; unit: number; name: string }[], amounts: Record<string, number>, address: unknown) => ({ lines, amounts, address });
      const beforeSnap = snapshot(items.map(i => ({ sku: i.sku, name: i.name, size: i.size, qty: i.qty, unit: i.unit_price_paise })),
        { subtotal: o.subtotal_paise, discount: o.discount_paise, shipping: o.shipping_paise, tax: o.tax_paise, cod_fee: o.cod_fee_paise, total: o.total_paise }, oldShip);
      const afterSnap = snapshot(next.map(n => ({ sku: n.sku, name: n.item.name, size: n.size, qty: n.qty, unit: n.item.unit_price_paise })),
        { subtotal, discount, shipping, tax, cod_fee: o.cod_fee_paise, total }, newAddress ?? oldShip);
      const edit = await tx.insertInto('order_edits').values({ order_id: o.id, staff_id: actor.staffId, note: input.note, before: JSON.stringify(beforeSnap), after: JSON.stringify(afterSnap),
        total_before: o.total_paise, total_after: total, refund_due_paise: refundDue }).returning('id').executeTakeFirstOrThrow();
      await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'order.edit', entityType: 'orders', entityId: o.id,
        before: beforeSnap, after: afterSnap, metadata: { order_number: o.order_number, edit_id: edit.id, note: input.note, refund_due_paise: refundDue, stock: deltas }, ...auditCtx(ctx) });
      return { editId: edit.id, orderNumber: o.order_number, totalBefore: o.total_paise, totalAfter: total, refundDuePaise: refundDue, cod: o.payment_method === 'cod' };
    });
    if (r.refundDuePaise > 0) await raiseAlertSafely(db, { kind: 'payment.issue', title: `Refund due on order ${r.orderNumber}: ${rupees(r.refundDuePaise)} after an edit`,
      entityType: 'orders', entityId: input.orderId, link: `/orders/${input.orderId}`, dedupeKey: `order.edit_refund:${r.editId}` });
    return r;
  } catch (e) {
    if ((e as { code?: string })?.code === '23514') throw new ConflictError('There is not enough stock for this change.');
    throw e;
  }
}

/** The order's edits, newest first (order page). */
export async function listOrderEdits(q: Queryable, orderId: string) {
  return q.selectFrom('order_edits as e').leftJoin('staff_users as s', 's.id', 'e.staff_id').leftJoin('refunds as r', 'r.id', 'e.refund_id')
    .select(['e.id', 'e.note', 'e.before', 'e.after', 'e.total_before', 'e.total_after', 'e.refund_due_paise', 'e.created_at', 's.email as staff_email',
      'r.id as refund_id', 'r.status as refund_status', 'r.method as refund_method', 'r.reference as refund_reference'])
    .where('e.order_id', '=', orderId).orderBy('e.created_at', 'desc').execute();
}

/** Refunds the difference an edit left on an order paid online: through the payment provider, or recorded as paid outside
    the platform (bank transfer / UPI) with its reference. Needs refunds.create. */
export async function refundOrderEdit(db: Db, actor: StaffPrincipal, provider: PaymentProvider | null,
  input: { editId: string; mode: 'provider' | 'manual'; reference: string | null }, ctx: MutationContext) {
  requirePermission(actor, 'refunds.create');
  const pending = await db.transaction().execute(async tx => {
    const e = await tx.selectFrom('order_edits').select(['id', 'order_id', 'refund_due_paise', 'refund_id', 'note']).where('id', '=', input.editId).forUpdate().executeTakeFirst();
    if (!e) throw new NotFoundError('Edit not found.');
    if (e.refund_due_paise <= 0) throw new ConflictError('This edit left nothing to refund.');
    if (e.refund_id) throw new ConflictError('The refund for this edit has already been made.');
    const o = await tx.selectFrom('orders').select(['id', 'order_number']).where('id', '=', e.order_id).forUpdate().executeTakeFirstOrThrow();
    const pay = (await refundable(tx, o.id)).find(p => p.left >= e.refund_due_paise);
    if (!pay) throw new ConflictError('No payment on this order can take this refund.');
    if (input.mode === 'provider') {
      if (!provider?.refund || provider.code !== pay.provider)
        throw new ConflictError(`Refunds through ${pay.provider} are not available from the admin. Refund it in the provider's dashboard or by bank transfer, then record it here with its reference.`);
      if (!pay.provider_payment_id) throw new ConflictError('This payment has no provider payment id. Record the refund as paid outside the platform instead.');
    }
    const manual = input.mode === 'manual';
    const f = await tx.insertInto('refunds').values({ payment_id: pay.id, order_id: o.id, amount_paise: e.refund_due_paise, reason: `Order edited: ${e.note}`.slice(0, 500),
      status: manual ? 'processed' : 'pending', method: input.mode, reference: input.reference, requested_by: actor.staffId,
      ...(manual ? { processed_at: sql<Date>`now()`, processed_by: actor.staffId } : {}) }).returning('id').executeTakeFirstOrThrow();
    await tx.updateTable('order_edits').set({ refund_id: f.id }).where('id', '=', e.id).execute();
    if (manual) await markPaymentRefunded(tx, o.id, pay.id);
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: manual ? 'refund.manual_record' : 'refund.provider_request', entityType: 'refunds', entityId: f.id,
      after: { amount_paise: e.refund_due_paise, method: input.mode, reference: input.reference, status: manual ? 'processed' : 'pending' },
      metadata: { order_number: o.order_number, edit_id: e.id, payment_id: pay.id }, ...auditCtx(ctx) });
    return { refundId: f.id, orderId: o.id, orderNumber: o.order_number, amount: e.refund_due_paise, payment: pay };
  });
  if (input.mode === 'manual') return { status: 'processed' as const };

  let answer: Awaited<ReturnType<NonNullable<PaymentProvider['refund']>>> | null = null, failure: string | null = null;
  try {
    answer = await provider!.refund!({ paymentId: pending.payment.provider_payment_id!, amountPaise: pending.amount, currency: pending.payment.currency,
      notes: { order_number: pending.orderNumber, reason: 'order edited' } });
    if (answer.status === 'failed') failure = 'The provider reported the refund as failed.';
  } catch (e) {
    failure = e instanceof DomainError ? e.message : `The provider did not accept the refund: ${String((e as Error).message ?? e).slice(0, 200)}`;
  }
  await db.transaction().execute(async tx => {
    if (failure) {
      await tx.updateTable('refunds').set({ status: 'failed', failure_reason: failure.slice(0, 300), provider_refund_id: answer?.id ?? null }).where('id', '=', pending.refundId).execute();
      await tx.updateTable('order_edits').set({ refund_id: null }).where('id', '=', input.editId).execute();   // it can be tried again
    } else {
      const done = answer!.status === 'processed';
      await tx.updateTable('refunds').set({ status: done ? 'processed' : 'pending', provider_refund_id: answer!.id, ...(done ? { processed_at: sql<Date>`now()`, processed_by: actor.staffId } : {}) })
        .where('id', '=', pending.refundId).execute();
      if (done) await markPaymentRefunded(tx, pending.orderId, pending.payment.id);
    }
    await recordAudit(tx, { actorType: 'system', action: failure ? 'refund.provider_failed' : 'refund.provider_answer', entityType: 'refunds', entityId: pending.refundId,
      after: failure ? { status: 'failed', failure_reason: failure } : { status: answer!.status, provider_refund_id: answer!.id } });
  });
  if (failure) {
    await raiseAlertSafely(db, { kind: 'refund.failed', title: `Refund failed for order ${pending.orderNumber}`, body: failure, entityType: 'orders', entityId: pending.orderId, link: `/orders/${pending.orderId}` });
    throw new ConflictError(`${failure} Nothing was refunded.`);
  }
  return { status: answer!.status };
}

/** What the order page's edit form needs: why the order cannot be edited (or null), and for each line the sizes it can
    change to (active sizes of the same product at the same price). Needs orders.edit. */
export async function orderEditOptions(db: Db, actor: StaffPrincipal, orderId: string) {
  requirePermission(actor, 'orders.edit');
  const blocker = await orderEditBlocker(db, orderId);
  const items = await db.selectFrom('order_items').select(['id', 'product_id', 'variant_id', 'name', 'size', 'sku', 'qty']).where('order_id', '=', orderId).orderBy('sku').execute();
  const productIds = [...new Set(items.map(i => i.product_id).filter((x): x is string => !!x))];
  const variants = productIds.length ? await db.selectFrom('product_variants').select(['id', 'product_id', 'size', 'sku', 'price_paise', 'is_active', 'stock_qty', 'sort_order', 'colour_slug', sql<string | null>`(select av.label from public.attribute_values av where av.attribute_id = 'colour' and av.slug = colour_slug)`.as('colour_label')])
    .where('product_id', 'in', productIds).orderBy('sort_order').execute() : [];
  return {
    blocker,
    items: items.map(i => {
      const now = variants.find(v => v.id === i.variant_id);
      const sizes = variants.filter(v => v.product_id === i.product_id && (v.id === i.variant_id || (v.is_active && (v.price_paise ?? null) === (now?.price_paise ?? null))))
        .map(v => ({ id: v.id, label: `${v.colour_slug ? `${v.colour_label ?? v.colour_slug} / ` : ''}${v.size} · ${v.stock_qty > 0 ? `${v.stock_qty} in stock` : 'sold out'}${v.id === i.variant_id ? ' (current)' : ''}` }));
      return { ...i, sizes: sizes.length ? sizes : i.variant_id ? [{ id: i.variant_id, label: `${i.size} (current)` }] : [] };
    }),
  };
}
