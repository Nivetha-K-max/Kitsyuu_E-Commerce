import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError, uuid } from '@kitsyuu/contracts';
import { customerBasket, getCustomer, getCustomerLoyalty, listCustomerNotes, LOYALTY_KIND_LABELS } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, TextArea } from '@/components/forms';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { addCustomerNoteAction, setCustomerStatusAction, updateCustomerContactAction } from '../actions';
import { adjustPointsAction } from '../../loyalty/actions';

export const metadata: Metadata = { title: 'Customer' };
type Params = Promise<{ id: string }>;

/* Shows safe account data only: the services never select password hashes, token hashes, IP addresses or user agents,
   and the admin database role cannot read the secret columns at all (migration 1800). */
export default async function CustomerPage({ params }: { params: Params }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/customers', label: 'Customers' }];
  if (!can(actor, 'customers.read')) return <><PageHead section="Commerce" title="Customer" crumbs={crumbs} /><Forbidden permission="customers.read" /></>;
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const d = await getCustomer(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const [notes, basket, loyalty] = await Promise.all([listCustomerNotes(db(), actor, id), customerBasket(db(), actor, id),
    can(actor, 'loyalty.read') ? getCustomerLoyalty(db(), actor, id) : Promise.resolve(null)]);
  const c = d.customer;
  const activeSessions = d.sessions.filter(s => s.active).length;
  const disabling = c.status === 'active';
  return (
    <>
      <PageHead section="Commerce" title={c.fullName || c.email} eyebrow={c.email} crumbs={crumbs}>
        <span className="head-status" data-customer-status={c.status}><span className="head-status-label">Account</span><StatusBadge status={c.status} /></span>
      </PageHead>

      <dl className="kpis minor" aria-label="Customer figures" data-customer-kpis>
        <div className="kpi" data-kpi="Orders"><dt>Orders</dt><dd>{formatNumber(d.summary.ordersCount)}<small>{formatNumber(d.summary.paidOrdersCount)} paid</small></dd></div>
        <div className="kpi" data-kpi="Lifetime value"><dt>Lifetime value</dt><dd>{formatPaise(d.summary.lifetimeValuePaise)}<small>Paid orders</small></dd></div>
        <div className="kpi" data-kpi="Last order"><dt>Last order</dt><dd>{formatDateTime(d.summary.lastOrderAt)}</dd></div>
      </dl>

      <div className="grid two">
        <section className="card" aria-labelledby="prof-h" data-section="profile">
          <h2 id="prof-h">Profile &amp; contact</h2>
          <dl className="facts">
            <dt>Name</dt><dd>{c.fullName || '—'}</dd>
            <dt>Email</dt><dd>{c.email} {c.emailVerifiedAt ? <span className="note">verified {formatDateTime(c.emailVerifiedAt)}</span> : <span className="note">not verified</span>}</dd>
            <dt>Mobile</dt><dd>{c.phone ?? '—'}</dd>
            <dt>Sign-in</dt><dd>{c.platformLogin ? 'Store account (email and password)' : 'Account from before the M6 login (password not yet set here)'}</dd>
            <dt>Last login</dt><dd>{formatDateTime(c.lastLoginAt)}</dd>
            <dt>Password changed</dt><dd>{formatDateTime(c.passwordChangedAt)}</dd>
            <dt>Joined</dt><dd>{formatDateTime(c.createdAt)}</dd>
          </dl>
          {d.canManage ? (
            <>
              <h3 className="sub">Correct contact details</h3>
              <ActionForm action={updateCustomerContactAction} submitLabel="Save contact details" pendingLabel="Saving…" id="customer-contact-form" label="Customer contact details">
                <Hidden name="customerId" value={c.id} />
                <Field name="fullName" label="Name" defaultValue={c.fullName ?? ''} />
                <Field name="phone" label="Mobile number" type="tel" defaultValue={c.phone ?? ''} hint="10-digit Indian mobile number, or leave empty." />
                <p className="note">The email is the customer&apos;s login and is not changed here. Every change is recorded in the audit log.</p>
              </ActionForm>
            </>
          ) : <p className="note" data-readonly="customer">Changing customer accounts needs the customers.manage permission.</p>}
        </section>

        <section className="card" aria-labelledby="acc-h" data-section="account">
          <h2 id="acc-h">Account access</h2>
          <dl className="facts">
            <dt>Status</dt><dd><StatusBadge status={c.status} /></dd>
            <dt>Active sessions</dt><dd data-active-sessions>{activeSessions}</dd>
          </dl>
          {d.canManage && (
            <ActionForm action={setCustomerStatusAction} id="customer-status-form" label={disabling ? 'Disable account' : 'Enable account'}
              submitLabel={disabling ? 'Disable account' : 'Enable account'} pendingLabel="Saving…" variant={disabling ? 'danger' : undefined}
              confirmText={disabling ? `Disable ${c.email}? They are signed out everywhere and cannot log in until the account is enabled again.` : `Enable ${c.email}?`}>
              <Hidden name="customerId" value={c.id} />
              <Hidden name="expectedStatus" value={c.status} />
              <Hidden name="status" value={disabling ? 'disabled' : 'active'} />
              <TextArea name="note" label="Reason (kept in the audit log)" rows={2} required />
            </ActionForm>
          )}
          <h3 className="sub">Recent sessions</h3>
          {d.sessions.length === 0 ? <p className="empty">No sessions.</p> : (
            <div className="table-wrap"><table data-sessions-table>
              <thead><tr><th>Started</th><th>Last seen</th><th>Ends</th><th>State</th></tr></thead>
              <tbody>{d.sessions.map(s => (
                <tr key={s.id}><td>{formatDateTime(s.createdAt)}</td><td>{formatDateTime(s.lastSeenAt)}</td><td>{formatDateTime(s.expiresAt)}</td>
                  <td>{s.active ? <StatusBadge status="active" /> : s.revokedAt ? <span className="note">ended {formatDateTime(s.revokedAt)}</span> : <span className="note">expired</span>}</td></tr>))}
              </tbody></table></div>
          )}
          <h3 className="sub">Recent login attempts</h3>
          {d.loginAttempts.length === 0 ? <p className="empty">No login attempts recorded.</p> : (
            <ul className="plain" data-login-attempts>{d.loginAttempts.map((a, i) => (
              <li key={i}>{a.success ? 'Signed in' : 'Failed'} <span className="note">· {formatDateTime(a.at)}{a.reason ? ` · ${a.reason.replace(/_/g, ' ')}` : ''}</span></li>))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid two">
        <section className="card" aria-labelledby="ord-h" data-section="orders">
          <h2 id="ord-h">Orders</h2>
          {d.orders.length === 0 ? <Empty title="No orders" compact>This customer has not placed an order.</Empty> : (
            <div className="table-wrap"><table data-customer-orders>
              <thead><tr><th>Order</th><th>Placed</th><th className="num">Total</th><th>Payment</th><th>Status</th></tr></thead>
              <tbody>{d.orders.map(o => (
                <tr key={o.id} data-order-row={o.order_number}>
                  <td className="mono">{can(actor, 'orders.read') ? <Link className="row-link" href={`/orders/${o.id}`}>{o.order_number}</Link> : o.order_number}</td>
                  <td className="nowrap">{formatDateTime(o.created_at)}</td>
                  <td className="num money">{formatPaise(o.total_paise)}</td>
                  <td>{o.payment_status ? <StatusBadge status={o.payment_status} /> : '—'}</td>
                  <td><StatusBadge status={o.status} /></td>
                </tr>))}
              </tbody></table></div>
          )}
        </section>
        <section className="card" aria-labelledby="addr-h" data-section="addresses">
          <h2 id="addr-h">Saved addresses</h2>
          {d.addresses.length === 0 ? <p className="empty">No saved addresses.</p> : (
            <ul className="plain" data-addresses>{d.addresses.map(a => (
              <li key={a.id}>{a.is_default && <span className="badge">Default</span>}<b>{a.full_name}</b> <span className="note">{a.phone}</span>
                <div>{[a.line1, a.line2, `${a.city}, ${a.state} ${a.pin}`, a.country].filter(Boolean).join(' · ')}</div></li>))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid two">
        <section className="card" aria-labelledby="notes-h" data-section="notes">
          <h2 id="notes-h">Service notes</h2>
          <p className="note">Internal only; the customer never sees them.</p>
          {notes.length ? <ul className="plain notes-list" data-notes>{notes.map(n => (
            <li key={n.id}><p className="note-body">{n.body}</p><span className="note">{n.author ?? 'staff'} · {formatDateTime(n.created_at as Date)}</span></li>
          ))}</ul> : <p className="empty" data-empty="notes">No notes yet.</p>}
          {can(actor, 'customers.note') && (
            <ActionForm action={addCustomerNoteAction} submitLabel="Add note" id="note-form" label="Add a note" resetOnSuccess>
              <Hidden name="customerId" value={id} />
              <TextArea name="body" label="Note" rows={3} required />
            </ActionForm>
          )}
        </section>
        <section className="card" aria-labelledby="basket-h" data-section="basket">
          <h2 id="basket-h">Cart and wishlist now</h2>
          <h3 className="sub-h">Cart</h3>
          {basket.cart.length ? <ul className="plain" data-cart>{basket.cart.map(i => <li key={i.id}>{i.name} · size {i.size} × {i.qty} <span className="note mono">{i.sku}</span></li>)}</ul>
            : <p className="empty">The cart is empty.</p>}
          <h3 className="sub-h">Wishlist</h3>
          {basket.wishlist.length ? <ul className="plain" data-wishlist>{basket.wishlist.map(i => <li key={i.id}>{i.name} <span className="note mono">{i.sku}</span></li>)}</ul>
            : <p className="empty">The wishlist is empty.</p>}
        </section>
      </div>

      {loyalty && (
        <section className="card" id="loyalty" aria-labelledby="loy-h" data-section="loyalty">
          <h2 id="loy-h">Loyalty points</h2>
          <p data-loyalty-balance><b>{formatNumber(loyalty.balance)}</b> points</p>
          {loyalty.rows.length === 0 ? <p className="empty">No point changes yet.</p> : (
            <div className="table-wrap"><table data-loyalty-history>
              <thead><tr><th>When</th><th>Change</th><th className="num">Points</th><th>Details</th></tr></thead>
              <tbody>{loyalty.rows.map(t => (
                <tr key={t.id}><td className="nowrap">{formatDateTime(t.created_at as Date)}</td><td>{LOYALTY_KIND_LABELS[t.kind] ?? t.kind}</td>
                  <td className="num">{t.points > 0 ? `+${t.points}` : t.points}</td>
                  <td>{t.order_number && <Link href={`/orders/${t.order_id}`}>{t.order_number}</Link>}{t.reason && <span className="note"> {t.reason}</span>}
                    {t.staff_email && <span className="note"> · {t.staff_email}</span>}{t.expires_at && (t.remaining ?? 0) > 0 && <span className="note"> · {t.remaining} expire {formatDateTime(t.expires_at as Date)}</span>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {can(actor, 'loyalty.adjust') && (
            <ActionForm action={adjustPointsAction} submitLabel="Save" id="loyalty-adjust-form" label="Add or remove points" className="form spaced" resetOnSuccess>
              <Hidden name="customerId" value={id} />
              <div className="cols">
                <Field name="points" label="Points" hint="e.g. 100 to add, -50 to remove" required />
                <Field name="reason" label="Reason" required hint="Kept in the points history" />
              </div>
            </ActionForm>
          )}
        </section>
      )}

      <section className="card" aria-labelledby="aud-h" data-section="audit">
        <h2 id="aud-h">Audit</h2>
        {d.audit === undefined ? <p className="note">The audit trail needs the audit.read permission.</p>
          : d.audit.length === 0 ? <p className="empty">No recorded actions.</p>
          : <ul className="activity" data-customer-audit>{d.audit.map(a => (
              <li key={a.id}><span className="mono activity-action">{a.action}</span>
                <span className="activity-meta">{a.staff_email ?? a.actor_type} · {formatDateTime(a.occurred_at)}</span></li>))}
            </ul>}
      </section>
    </>
  );
}
