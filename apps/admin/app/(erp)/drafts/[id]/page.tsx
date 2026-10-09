import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { draftSizeOptions, getDraftOrder, lineProblemText, settingsShipping, type DraftAddress, type DraftPayment } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Forbidden, PageHead, SectionTitle, StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { cancelDraftAction, confirmDraftAction, setDraftAddressesAction, setDraftDiscountAction, setDraftItemAction, setDraftNoteAction } from '../actions';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Draft order' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
const PAY: Record<DraftPayment, string> = { online: 'Online payment (the customer pays from their account)', cod: 'Cash on delivery', cash: 'Cash', card: 'Card', upi: 'UPI' };

function AddressFields({ prefix, a }: { prefix: 'ship' | 'bill'; a: Partial<DraftAddress> | null }) {
  return (
    <>
      <Field name={`${prefix}Name`} label="Name" defaultValue={a?.name ?? ''} autoComplete="off" />
      <Field name={`${prefix}Phone`} label="Mobile number" defaultValue={a?.phone ?? ''} autoComplete="off" />
      <Field name={`${prefix}Line1`} label="Address line 1" defaultValue={a?.line1 ?? ''} autoComplete="off" />
      <Field name={`${prefix}Line2`} label="Address line 2 (optional)" defaultValue={a?.line2 ?? ''} autoComplete="off" />
      <Field name={`${prefix}City`} label="City" defaultValue={a?.city ?? ''} autoComplete="off" />
      <Field name={`${prefix}State`} label="State" defaultValue={a?.state ?? ''} autoComplete="off" />
      <Field name={`${prefix}Pin`} label="PIN" defaultValue={a?.pin ?? ''} autoComplete="off" />
    </>
  );
}
const addressText = (a: Partial<DraftAddress> | null) => a ? [a.name, a.phone, a.line1, a.line2, [a.city, a.state, a.pin].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '—';

export default async function DraftPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/orders?view=draft', label: '← Back to draft orders' }];
  if (!can(actor, 'orders.read')) return <><PageHead title="Draft order" crumbs={crumbs} /><Forbidden permission="orders.read" /></>;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const sp = await searchParams;
  const want = (Array.isArray(sp.payment) ? sp.payment[0] : sp.payment) as DraftPayment | undefined;
  const config = { shipping: settingsShipping(() => db()), discounts: [] };
  const peek = await getDraftOrder(db(), actor, id, { config }).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const choices: DraftPayment[] = peek.draft.channel === 'retail' ? ['cash', 'card', 'upi'] : ['online', 'cod'];
  const payment = want && choices.includes(want) ? want : choices[0];
  const v = payment === peek.payment ? peek : await getDraftOrder(db(), actor, id, { payment, config });
  const { draft: d, lines, totals: t, customer, location, owner } = v;
  const open = d.status === 'open', edit = open && can(actor, 'orders.create'), discount = open && can(actor, 'orders.discount');
  const sizes = edit ? await draftSizeOptions(db(), actor, id) : [];
  const contact = (d.contact ?? {}) as { name?: string | null; email?: string | null; phone?: string | null };
  const ship = d.shipping_address as DraftAddress | null, bill = d.billing_address as DraftAddress | null;
  const codRefused = payment === 'cod' && t.payment?.method !== 'cod';
  const staff = t.discounts.find(x => x.code === 'STAFF');
  return (
    <Workspace name="draft" title={d.number} summary={d.channel === 'retail' ? `In store · ${location?.name ?? ''}` : 'Online order (delivered)'} crumbs={crumbs}
      actions={<div className="ord-head-actions"><StatusBadge status={d.status === 'open' ? 'draft' : d.status === 'confirmed' ? 'processed' : 'cancelled'} /></div>}>
      {d.status === 'confirmed' && d.order_id && <p className="msg ok" role="status" data-draft-confirmed>This draft became an order: <Link href={`/orders/${d.order_id}`}>open the order</Link>.</p>}
      <dl className="facts" data-draft-meta>
        <dt>Customer</dt><dd>{customer ? <><Link href={`/customers/${customer.id}`}>{customer.full_name ?? customer.email}</Link> · {customer.email}</> : `${contact.name ?? 'Walk-in customer'}${contact.phone ? ` · ${contact.phone}` : ''}${contact.email ? ` · ${contact.email}` : ''}`}</dd>
        <dt>Created</dt><dd>{formatDateTime(d.created_at as Date)}{owner ? ` · ${owner.email}` : ''}</dd>
        <dt>Last updated</dt><dd>{formatDateTime(d.updated_at as Date)}</dd>
        {d.note && <><dt>Note</dt><dd>{d.note}</dd></>}
      </dl>

      <section className="card" aria-labelledby="di-h" data-section="draft-items">
        <SectionTitle id="di-h">Items</SectionTitle>
        {lines.length === 0 ? <p className="note">No items yet.</p> : (
          <div className="table-wrap"><table data-draft-lines>
            <thead><tr><th>Item</th><th>SKU</th><th className="num">Unit price</th><th className="num">Qty</th><th className="num">Amount</th>{edit && <th>Change</th>}</tr></thead>
            <tbody>{lines.map(l => (
              <tr key={l.variantId} data-sku={l.sku}>
                <td>{l.name}{l.colourLabel ? ` · ${l.colourLabel}` : ''} · {l.size}{l.problem && d.channel === 'online' ? <div className="msg error" data-line-problem>{lineProblemText(l)}</div> : null}</td>
                <td className="mono">{l.sku}</td><td className="num">{formatPaise(l.unitPaise)}</td><td className="num">{l.qty}</td><td className="num">{formatPaise(l.lineTotalPaise)}</td>
                {edit && <td>
                  <ActionForm action={setDraftItemAction} submitLabel="Set" variant="ghost" className="inline-form" id={`qty-${l.variantId}`} label={`Quantity of ${l.sku}`}>
                    <Hidden name="draftId" value={d.id} /><Hidden name="variantId" value={l.variantId} />
                    <Field name="qty" label="Qty (0 removes)" defaultValue={String(l.qty)} />
                  </ActionForm>
                </td>}
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {edit && (
          <ActionForm action={setDraftItemAction} submitLabel="Add item" id="draft-add-item-form" label="Add an item" resetOnSuccess>
            <Hidden name="draftId" value={d.id} />
            <Select name="variantId" label="Item and size" required options={[{ value: '', label: 'Choose…' },
              ...sizes.map(s => ({ value: s.variantId, label: `${s.label} (${s.sku}) · ${formatPaise(s.unitPaise)} · ${s.inStock} in stock${d.channel === 'retail' ? ' here' : ''}` }))]} />
            <Field name="qty" label="Quantity" defaultValue="1" />
          </ActionForm>
        )}
      </section>

      {d.channel === 'online' && (
        <section className="card form-panel" aria-labelledby="da-h" data-section="draft-addresses">
          <h2 id="da-h">Delivery and billing address</h2>
          {!edit ? <dl className="facts"><dt>Delivery</dt><dd>{addressText(ship)}</dd><dt>Billing</dt><dd>{bill ? addressText(bill) : 'Same as delivery'}</dd></dl> : (
            <ActionForm action={setDraftAddressesAction} submitLabel="Save addresses" id="draft-addresses-form" label="Addresses" className="form cols-form">
              <Hidden name="draftId" value={d.id} />
              <p className="note span-2">Delivery address{v.addresses.length ? ` (the customer has ${v.addresses.length} saved address${v.addresses.length === 1 ? '' : 'es'}; the default one is filled in)` : ''}.</p>
              <AddressFields prefix="ship" a={ship} />
              <div className="span-2"><Checkbox name="billingSame" label="Billing address is the same as the delivery address" defaultChecked={!bill} /></div>
              <p className="note span-2">Billing address (only used when the box above is not ticked).</p>
              <AddressFields prefix="bill" a={bill} />
            </ActionForm>
          )}
        </section>
      )}

      <section className="card form-panel" aria-labelledby="dd-h" data-section="draft-discount">
        <h2 id="dd-h">Discount</h2>
        <p className="note" data-discount-limit>{v.maxDiscountBp === null ? 'Staff discounts are not set up (Configuration → Discounts → "Maximum staff discount").'
          : `At most ${v.maxDiscountBp / 100}%, and never below a product's minimum price. A reason is required.`}</p>
        {d.discount_bp ? <p data-draft-discount>{d.discount_bp / 100}% · {d.discount_reason}{staff ? ` · ${formatPaise(staff.amountPaise)} off` : ''}</p> : <p className="note">No discount.</p>}
        {discount && v.maxDiscountBp !== null && (
          <ActionForm action={setDraftDiscountAction} submitLabel="Save discount" id="draft-discount-form" label="Discount">
            <Hidden name="draftId" value={d.id} />
            <Field name="percent" label="Discount %" defaultValue={d.discount_bp ? String(d.discount_bp / 100) : ''} hint="Empty or 0 removes the discount." />
            <Field name="reason" label="Reason" defaultValue={d.discount_reason ?? ''} hint='e.g. "Customer loyalty discount"' />
          </ActionForm>
        )}
      </section>

      {edit && (
        <section className="card form-panel" aria-labelledby="dno-h" data-section="draft-note">
          <h2 id="dno-h">Note</h2>
          <ActionForm action={setDraftNoteAction} submitLabel="Save note" id="draft-note-form" label="Note">
            <Hidden name="draftId" value={d.id} /><TextArea name="note" label="Note (staff only)" defaultValue={d.note ?? ''} rows={2} />
          </ActionForm>
        </section>
      )}

      <section className="card" aria-labelledby="dt-h" data-section="draft-totals">
        <SectionTitle id="dt-h">Totals</SectionTitle>
        <nav className="tabs actions" aria-label="How the customer pays" data-payment-choices>
          {choices.map(c => <Link key={c} className={`btn ${c === payment ? '' : 'ghost'} sm`} href={`/drafts/${d.id}?payment=${c}`} aria-current={c === payment ? 'page' : undefined}>{PAY[c]}</Link>)}
        </nav>
        <dl className="facts" data-draft-totals>
          <dt>Items</dt><dd>{formatPaise(t.subtotalPaise)}</dd>
          {t.discounts.map(x => <span key={x.code} style={{ display: 'contents' }}><dt>{x.label}</dt><dd>−{formatPaise(x.amountPaise)}</dd></span>)}
          {d.channel === 'online' && <><dt>Delivery</dt><dd>{t.shipping.configured ? formatPaise(t.shippingPaise) : `${formatPaise(0)} (${t.shipping.label})`}{t.shipping.unavailable ? ` · ${t.shipping.unavailable}` : ''}</dd></>}
          {t.codFeePaise > 0 && <><dt>Cash on delivery fee</dt><dd>{formatPaise(t.codFeePaise)}</dd></>}
          {t.tax.configured && <><dt>{t.tax.label}{t.pricesIncludeTax ? ' (included)' : ''}</dt><dd>{formatPaise(t.taxPaise)}</dd></>}
          <dt>Total</dt><dd data-draft-total><b>{formatPaise(t.totalPaise)}</b></dd>
        </dl>
        {codRefused && <p className="msg error" role="alert">{t.payment?.cod.reason ?? 'Cash on delivery is not available for this order.'}</p>}
        {edit && (
          <div className="actions">
            <ActionForm action={confirmDraftAction} submitLabel={d.channel === 'retail' ? `Confirm: paid by ${PAY[payment].toLowerCase()}` : payment === 'cod' ? 'Confirm: cash on delivery' : 'Confirm: customer pays online'}
              id="confirm-draft-form" label="Confirm the draft" className="inline-form"
              confirmText={d.channel === 'retail' ? `Create the order? ${formatPaise(t.totalPaise)} paid by ${PAY[payment].toLowerCase()}; the items leave ${location?.name} now.`
                : `Create the order for ${formatPaise(t.totalPaise)}? The items are set aside for the customer${payment === 'cod' ? ' and the order goes to packing' : ' until they pay'}.`}>
              <Hidden name="draftId" value={d.id} /><Hidden name="payment" value={payment} /><Hidden name="expectedTotalPaise" value={String(t.totalPaise)} />
            </ActionForm>
            <ActionForm action={cancelDraftAction} submitLabel="Cancel draft" variant="ghost" id="cancel-draft-form" label="Cancel the draft" className="inline-form" confirmText={`Cancel ${d.number}? It cannot be reopened.`}>
              <Hidden name="draftId" value={d.id} />
            </ActionForm>
          </div>
        )}
        {edit && !v.canConfirm && <p className="note" data-cannot-confirm>{lines.length === 0 ? 'Add items to confirm.' : d.channel === 'online' && !ship ? 'Enter the delivery address to confirm.' : 'Some items are not available (see above).'}</p>}
      </section>
    </Workspace>
  );
}
