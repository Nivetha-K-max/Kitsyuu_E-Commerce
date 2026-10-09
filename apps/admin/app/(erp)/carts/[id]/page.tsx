import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getCart } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select } from '@/components/forms';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { cartRecoveryAction, sendReminderAction } from '../actions';
import { Entity, Section } from '@/components/frame';
import RecordActivity from '@/components/RecordActivity';

export const metadata: Metadata = { title: 'Cart' };

export default async function CartPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/carts', label: 'Carts' }];
  if (!can(actor, 'carts.read')) return <><PageHead title="Cart" crumbs={crumbs} /><Forbidden permission="carts.read" /></>;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let data;
  try { data = await getCart(db(), actor, id); } catch (e) { if (e instanceof NotFoundError) notFound(); throw e; }
  const { cart: c, items, abandoned } = data;
  const manage = can(actor, 'carts.manage');
  const seeAudit = can(actor, 'audit.read');
  const tab = (await searchParams).tab === 'activity' && seeAudit ? 'activity' : 'main';
  const selfHref = `/carts/${c.id}`;
  return (
    <Entity module={{ href: '/carts', label: 'Carts & wishlists' }} name="cart" title={c.email ? `Cart · ${c.email}` : 'Guest cart'}
      status={<span className="badge as-written" data-cart-state>{abandoned ? 'Abandoned' : c.status}</span>}
      factsAttr="data-cart-facts" facts={[{ label: 'Last activity', value: formatDateTime(c.last_activity as Date) }, { label: 'Value at today’s prices', value: formatPaise(c.value_paise) }]}
      tabs={[{ id: 'main', label: 'Items' }, ...(seeAudit ? [{ id: 'activity', label: 'Activity' }] : [])]} current={tab} tabHref={x => (x === 'main' ? selfHref : `${selfHref}?tab=${x}`)}
      actions={<div className="ord-head-actions">
        {c.customer_id && can(actor, 'customers.read') && <Link className="btn ghost" href={`/customers/${c.customer_id}`}>Customer</Link>}
      </div>}>
      {tab === 'activity' && (
        <Section id="act-h" title="Activity" name="activity" wide hint="Changes to this cart, from the audit log.">
          <RecordActivity entityType="carts" entityId={c.id} name="cart" empty="Changes to this cart are listed here as they are made." />
        </Section>
      )}
      {tab === 'main' && <>
      <p className="note">Read-only: staff cannot change a customer’s cart. Stock is not held for carts.</p>
      <div className="table-wrap"><table data-cart-items>
        <thead><tr><th>Product</th><th>Size</th><th className="num">Qty</th><th className="num">Price now</th><th className="num">In stock</th><th>Added / changed</th></tr></thead>
        <tbody>{items.map(i => (
          <tr key={i.id}><td>{i.name}<div className="note mono">{i.sku}</div>{i.product_status !== 'active' && <span className="badge inactive">not on sale</span>}</td><td>{i.size}</td>
            <td className="num">{i.qty}</td><td className="num money">{formatPaise(i.unit_paise)}</td><td className="num">{i.stock_qty}</td><td className="nowrap">{formatDateTime(i.updated_at as Date)}</td></tr>
        ))}</tbody>
      </table></div>
      <section className="card" aria-labelledby="rc-h" data-section="recovery">
        <h2 id="rc-h">Recovery</h2>
        <p>Status: {c.recovery_status ? <StatusBadge status={c.recovery_status} /> : 'not tracked'}{c.emailed_at ? ` · last reminder ${formatDateTime(c.emailed_at as Date)} (${c.email_count} sent)` : ''}
          {c.recovery_note ? ` · ${c.recovery_note}` : ''}{c.recovery_by ? ` · by ${c.recovery_by}` : ''}</p>
        {manage && <div className="grid-2">
          <ActionForm action={cartRecoveryAction} submitLabel="Save status" id="cart-recovery-form" label="Recovery status">
            <Hidden name="cartId" value={c.id} />
            <Select name="status" label="Status" defaultValue={c.recovery_status === 'emailed' ? 'open' : c.recovery_status ?? 'open'} options={[{ value: 'open', label: 'Open' }, { value: 'recovered', label: 'Recovered' }, { value: 'dismissed', label: 'Dismissed' }]} />
            <Field name="note" label="Note (staff only)" defaultValue={c.recovery_note ?? ''} />
          </ActionForm>
          {abandoned && c.email && (
            <ActionForm action={sendReminderAction} submitLabel="Send reminder email" variant="ghost" id="cart-reminder-form" label="Send reminder" confirmText={`Email ${c.email} a reminder about this cart?`}>
              <Hidden name="cartId" value={c.id} />
              <p className="note">Lists the items still on sale and links to the cart. Only sent when Configuration → Customer emails → “Abandoned-cart reminder emails” is on.</p>
            </ActionForm>
          )}
        </div>}
      </section>
      </>}
    </Entity>
  );
}
