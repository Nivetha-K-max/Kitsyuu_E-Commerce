import ModuleViews from '@/components/ModuleViews';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listLoyaltyAccounts, LOYALTY_IMPORT_MAX_LINES, LOYALTY_KIND_LABELS, LOYALTY_TIER_LABELS, LOYALTY_TIERS, type LoyaltyTier } from '@kitsyuu/core';
import { ActionForm, Field, TextArea } from '@/components/forms';
import FilterForm from '@/components/FilterForm';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { one, pageOf, type SP } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { importPointsAction } from './actions';
import { Figures, Workspace } from '@/components/frame';
import { FilterLink } from '@/components/NavFrame';

export const metadata: Metadata = { title: 'Loyalty points' };

/* Client change request, second pass: loyalty points. Balances, the latest point changes, the rules in force (from
   Configuration → Loyalty; nothing is invented) and the import of opening balances. Points of one customer are adjusted on
   the customer's page. */
export default async function LoyaltyPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'loyalty.read')) return <><PageHead section="Growth" title="Loyalty points" /><Forbidden permission="loyalty.read" /></>;
  const sp = await searchParams;
  const q = one(sp.q).trim().slice(0, 80) || undefined;
  const page = pageOf(sp.page);
  // Tier filter (2026-10-13): only meaningful once the three tier values are set in Configuration → Loyalty.
  const asked = one(sp.tier);
  const tier = ([...LOYALTY_TIERS, 'none'] as string[]).includes(asked) ? asked as LoyaltyTier | 'none' : undefined;
  const d = await listLoyaltyAccounts(db(), actor, { q, page, tier });
  const s = d.settings, c = d.counts;
  const link = (o: { tier?: string; page?: number }) => { const p = new URLSearchParams(); if (q) p.set('q', q); if (o.tier) p.set('tier', o.tier); if (o.page && o.page > 1) p.set('page', String(o.page)); const x = p.toString(); return x ? `/loyalty?${x}` : '/loyalty'; };
  const qs = (p: number) => link({ tier, page: p });
  const rule = (v: string | null) => v ?? <span className="note">Not set</span>;
  return (
    <Workspace name="loyalty" title="Loyalty points" summary={`${formatNumber(d.totals.points)} points held by ${formatNumber(d.totals.customers)} customer(s)`}>
      <ModuleViews module="customers" label="Customers" current="/loyalty" />

      <Figures items={[
        { label: 'Members with points', value: <span data-loyalty-members>{formatNumber(d.totals.customers)}</span> },
        ...(c ? [{ label: 'Gold + Diamond', value: formatNumber(c.gold + c.diamond), note: `${formatNumber(c.diamond)} Diamond · ${formatNumber(c.gold)} Gold` }] : []),
        { label: 'Points outstanding', value: formatNumber(d.totals.points), note: s.pointValuePaise ? `worth ${formatPaise(d.totals.points * s.pointValuePaise)} at checkout` : 'no point value set' },
      ]} />

      <section className="card" aria-labelledby="rules-h" data-section="loyalty-rules">
        <h2 id="rules-h">Rules in force</h2>
        <dl className="facts" data-loyalty-rules>
          <dt>Loyalty points</dt><dd>{s.enabled ? 'On' : 'Off: customers do not earn or use points'}</dd>
          <dt>Earned</dt><dd>{rule(s.earnPer100 ? `${s.earnPer100} points per ₹100 of items paid for` : null)}</dd>
          <dt>Earned when</dt><dd>{rule(s.earnWhen === 'paid' ? 'The order is paid' : s.earnWhen === 'delivered' ? 'The order is delivered' : null)}</dd>
          <dt>One point is worth</dt><dd>{rule(s.pointValuePaise ? formatPaise(s.pointValuePaise) : null)}</dd>
          <dt>Per order</dt><dd>{s.minRedeem || s.maxRedeem ? [s.minRedeem && `at least ${s.minRedeem}`, s.maxRedeem && `at most ${s.maxRedeem}`].filter(Boolean).join(', ') + ' points' : 'No limit'}</dd>
          <dt>Expiry</dt><dd>{s.expiryMonths ? `${s.expiryMonths} months after they are added` : 'Points do not expire'}</dd>
          <dt>Tiers</dt><dd data-loyalty-tier-rule>{s.tiers ? `Silver from ${formatNumber(s.tiers.silver)} points, Gold from ${formatNumber(s.tiers.gold)}, Diamond from ${formatNumber(s.tiers.diamond)} (by current balance; a label only)` : <span className="note">Not set</span>}</dd>
        </dl>
        {can(actor, 'settings.read') && <p className="note">Change the rules under <Link href="/settings">Configuration → Loyalty</Link>.</p>}
      </section>

      <FilterForm className="actions" role="search" aria-label="Find a customer" data-loyalty-filters>
        <label className="sr-only" htmlFor="ly-q">Customer</label>
        <input id="ly-q" name="q" className="input" placeholder="Email or name" defaultValue={q ?? ''} />
        <button className="btn ghost" type="submit">Find</button>
      </FilterForm>
      {c && (
        <nav className="ord-chipset ord-stages" aria-label="Filter by tier" data-loyalty-tiers>
          <span className="ord-chip-label" aria-hidden="true">Tier</span>
          <FilterLink className="ord-chip" group="tier" href={link({})} current={!tier} data-loyalty-tier-chip="all">All<span className="ord-count">{c.diamond + c.gold + c.silver + c.none}</span></FilterLink>
          {LOYALTY_TIERS.map((k: LoyaltyTier) => <FilterLink key={k} className="ord-chip" group="tier" href={link({ tier: k })} current={tier === k} data-loyalty-tier-chip={k}>{LOYALTY_TIER_LABELS[k]}<span className="ord-count">{c[k]}</span></FilterLink>)}
          <FilterLink className="ord-chip" group="tier" href={link({ tier: 'none' })} current={tier === 'none'} data-loyalty-tier-chip="none">No tier<span className="ord-count">{c.none}</span></FilterLink>
        </nav>
      )}
      {d.rows.length === 0 && (tier || q) ? <Empty title="No customer matches" kind="loyalty">Try another tier or search.</Empty> : d.rows.length === 0 ? <Empty title="No customer has points" kind="loyalty">Points appear here once customers earn them or staff add them.</Empty> : (
        <div className="table-wrap"><table data-loyalty-table>
          <thead><tr><th>Customer</th>{s.tiers && <><th>Tier</th><th>To next tier</th></>}<th className="num">Points</th><th>Last change</th></tr></thead>
          <tbody>{d.rows.map(r => (
            <tr key={r.id} data-loyalty-customer={r.email}>
              <td>{can(actor, 'customers.read') ? <Link href={`/customers/${r.id}?tab=loyalty`}>{r.full_name || r.email}</Link> : r.full_name || r.email}<div className="note">{r.email}</div></td>
              {s.tiers && <>
                <td data-loyalty-tier={r.tier ?? 'none'}>{r.tier ? <span className={`badge tier-${r.tier}`}>{LOYALTY_TIER_LABELS[r.tier]}</span> : <span className="note">No tier</span>}</td>
                <td className="note">{r.next ? `${formatNumber(r.next.points)} points to ${LOYALTY_TIER_LABELS[r.next.tier]}` : 'Top tier'}</td>
              </>}
              <td className="num">{formatNumber(r.balance)}{s.pointValuePaise ? <div className="note">{formatPaise(r.balance * s.pointValuePaise)}</div> : null}</td><td className="nowrap">{formatDateTime(r.updated_at as Date)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <nav className="pager actions" aria-label="Pages">
        {page > 1 && <Link className="btn ghost sm" href={qs(page - 1)}>Previous</Link>}
        {d.hasNext && <Link className="btn ghost sm" href={qs(page + 1)}>Next</Link>}
      </nav>

      <div className="grid two">
        <section className="card" aria-labelledby="recent-h" data-section="loyalty-recent">
          <h2 id="recent-h">Latest changes</h2>
          {d.recent.length === 0 ? <p className="empty">No point changes yet.</p> : (
            <ul className="plain" data-loyalty-recent>{d.recent.map(t => (
              <li key={t.id}><b>{t.points > 0 ? `+${t.points}` : t.points}</b> {LOYALTY_KIND_LABELS[t.kind] ?? t.kind} · {t.email}
                {t.order_number && <> · <Link href={`/orders/${t.order_id}`}>{t.order_number}</Link></>}
                <span className="note"> · {formatDateTime(t.created_at as Date)}{t.reason ? ` · ${t.reason}` : ''}</span></li>
            ))}</ul>
          )}
        </section>
        {can(actor, 'loyalty.adjust') && (
          <section className="card" aria-labelledby="imp-h" data-section="loyalty-import">
            <h2 id="imp-h">Import opening balances</h2>
            <p className="note">One line per customer: <span className="mono">email,points</span> or <span className="mono">email,points,reason</span> (a header line is allowed; up to {LOYALTY_IMPORT_MAX_LINES} lines).
              Every email must belong to a customer account, otherwise nothing is imported. Points are added to what customers already have.</p>
            <ActionForm action={importPointsAction} submitLabel="Import points" id="loyalty-import-form" label="Import points" resetOnSuccess
              confirmText="Import these points? They are added to the customers' balances.">
              <div className="field"><label htmlFor="ly-file">CSV file</label><input id="ly-file" name="file" type="file" accept=".csv,.txt,text/csv,text/plain" className="input" /></div>
              <TextArea name="text" label="…or paste the lines" rows={4} hint="Used when no file is chosen." />
              <Field name="reason" label="Reason" required defaultValue="Opening balance" />
            </ActionForm>
          </section>
        )}
      </div>
    </Workspace>
  );
}
