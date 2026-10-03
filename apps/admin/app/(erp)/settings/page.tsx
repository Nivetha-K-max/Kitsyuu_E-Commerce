import type { Metadata } from 'next';
import Link from 'next/link';
import { Fragment } from 'react';
import { can } from '@kitsyuu/auth';
import { listSettings, type SettingRow } from '@kitsyuu/core';
import { ActionForm, Field, Hidden, Select, TextArea } from '@/components/forms';
import { Forbidden, PageHead } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { updateSettingAction } from './actions';

export const metadata: Metadata = { title: 'Configuration' };

const anchor = (group: string) => `g-${group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/* Configuration areas (client change request, 2026-10-03): one index of where each kind of business configuration lives.
   It adds no data and no second settings system. An area points at groups of the settings registry on this page (by
   group name, shown only when that group exists) and at the existing module that already owns the rest (shown only to
   staff who hold that module's permission). A new setting belongs in the registry (core/settings.ts) under one of these
   groups, and appears here by itself. */
const AREAS: { name: string; about: string; groups: string[]; links: { href: string; label: string; permission: string }[] }[] = [
  { name: 'Company', about: 'Legal name, address, GSTIN and contact details printed on bills, invoices and packing slips.', groups: ['Company', 'Store'], links: [] },
  { name: 'Locations', about: 'Warehouse and retail branches, and the stock each one holds.', groups: ['Inventory'],
    links: [{ href: '/locations', label: 'Locations', permission: 'inventory.read' }, { href: '/transfers', label: 'Transfers', permission: 'inventory.read' }] },
  { name: 'Billing', about: 'Invoice numbering and how customers may pay.', groups: ['Billing', 'Payments'],
    links: [{ href: '/finance/invoices', label: 'Invoices', permission: 'finance.read' }] },
  { name: 'Tax', about: 'Default tax rate, tax-inclusive prices and the registered state used to split GST.', groups: ['Billing', 'Company'],
    links: [{ href: '/finance/tax', label: 'Tax report', permission: 'finance.read' }] },
  { name: 'POS', about: 'Branches that bill, who may bill, and the staff discount limit.', groups: ['Discounts'],
    links: [{ href: '/locations', label: 'Branches', permission: 'inventory.read' }, { href: '/roles', label: 'Roles & permissions', permission: 'roles.read' },
      { href: '/pos/sessions', label: 'Cashier sessions', permission: 'pos.access' }] },
  { name: 'Orders', about: 'Checkout, cash on delivery, delivery charges, returns and customer emails.', groups: ['Checkout', 'Payments', 'Shipping', 'Returns', 'Customer emails'],
    links: [{ href: '/shipping', label: 'Shipping', permission: 'shipping.read' }] },
];

function show(s: SettingRow): string {
  if (s.value === null || s.value === undefined) return 'Not set';
  if (s.type.kind === 'boolean') return s.value ? 'Yes' : 'No';
  if (s.type.kind === 'integer') return `${s.value}${s.type.unit ? ` ${s.type.unit}` : ''}`;
  if (s.type.kind === 'money' && typeof s.value === 'number') return `₹${(s.value / 100).toLocaleString('en-IN', { minimumFractionDigits: s.value % 100 ? 2 : 0 })}`;
  if (s.type.kind === 'choice') { const t = s.type; return t.options.find(o => o.value === s.value)?.label ?? String(s.value); }
  if (s.type.kind === 'object' && typeof s.value === 'object')
    return Object.entries(s.value as Record<string, unknown>).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ');
  return String(s.value);
}

/* A read view of the typed settings registry. Only settings the registry marks editable get a form (one validated value,
   audited); everything else is shown with the reason it is locked. There is no free-form editor and no way to add keys. */
export default async function SettingsPage() {
  const actor = await requireActor();
  if (!can(actor, 'settings.read')) return <><PageHead section="System" title="Configuration" /><Forbidden permission="settings.read" /></>;
  const { groups, unregistered, policies } = await listSettings(db(), actor);
  const has = new Set(groups.map(g => g.group));
  return (
    <>
      <PageHead section="System" title="Configuration" eyebrow="Business rules are locked here; only safe operational settings can be changed, and every change is audited." />
      <section className="card" aria-labelledby="areas-h" data-section="config-areas">
        <h2 id="areas-h">Configuration areas</h2>
        <dl className="facts" data-config-areas>{AREAS.map(a => {
          const links = [...a.groups.filter(g => has.has(g)).map(g => ({ href: `#${anchor(g)}`, label: `${g} settings` })),
            ...a.links.filter(l => can(actor, l.permission))];
          return (
            <Fragment key={a.name}><dt>{a.name}</dt>
              <dd data-config-area={a.name}>{a.about}
                {links.length > 0 && <div className="note">{links.map((l, i) => <Fragment key={l.href}>{i > 0 && ' · '}<Link href={l.href}>{l.label}</Link></Fragment>)}</div>}</dd>
            </Fragment>);
        })}</dl>
      </section>
      {groups.map(g => (
        <section className="card" key={g.group} aria-labelledby={anchor(g.group)} data-settings-group={g.group}>
          <h2 id={anchor(g.group)}>{g.group}</h2>
          <div className="table-wrap"><table data-settings-table>
            <thead><tr><th>Setting</th><th>Value</th><th>Change</th></tr></thead>
            <tbody>{g.items.map(s => (
              <tr key={s.key} data-setting={s.key} data-editable={s.editable ? 'yes' : 'no'}>
                <td><b>{s.label}</b><div className="note">{s.description}</div><div className="note mono">{s.key}</div></td>
                <td data-setting-value>{show(s)}{s.updatedBy && <div className="note">changed by {s.updatedBy} · {formatDateTime(s.updatedAt)}</div>}</td>
                <td>{s.canEdit && ['integer', 'text', 'choice', 'money'].includes(s.type.kind) ? (
                  <ActionForm action={updateSettingAction} submitLabel="Save" pendingLabel="Saving…" label={`Change ${s.label}`} className="form inline">
                    <Hidden name="key" value={s.key} />
                    <SettingInput s={s} />
                  </ActionForm>
                ) : s.editable ? <span className="note">Changing it needs the settings.manage permission.</span>
                  : <span className="note" data-locked>Locked. {s.lockedReason}</span>}</td>
              </tr>))}
            </tbody></table></div>
        </section>
      ))}
      <section className="card" aria-labelledby="pol-h" data-section="policies">
        <h2 id="pol-h">Store policies</h2>
        <p className="note">Rules that live in code or deployment configuration. Shown for reference; they are not changed here.</p>
        <dl className="facts" data-policies>{policies.map(p => <Fragment key={p.label}><dt>{p.label}</dt><dd>{p.value}<div className="note">{p.source}</div></dd></Fragment>)}</dl>
      </section>
      {unregistered.length > 0 && (
        <section className="card" aria-labelledby="unreg-h" data-section="unregistered">
          <h2 id="unreg-h">Other stored values</h2>
          <p className="note">Values stored in the database that the settings registry does not describe. Read-only.</p>
          <ul className="plain">{unregistered.map(u => <li key={u.key}><span className="mono">{u.key}</span> <span className="note">{JSON.stringify(u.value)}</span></li>)}</ul>
        </section>
      )}
    </>
  );
}

/** The form field for one editable setting, by type. Validation happens on the server (core/settings.ts). */
function SettingInput({ s }: { s: SettingRow }) {
  const t = s.type;
  if (t.kind === 'integer') return <Field name="value" label={`${s.label}${t.unit ? ` (${t.unit})` : ''}`} type="number" defaultValue={String(s.value ?? '')} hint={`${t.min}–${t.max}${t.optional ? ' · Leave empty to clear.' : ''}`} />;
  if (t.kind === 'choice') return <Select name="value" label={s.label} defaultValue={String(s.value ?? t.options[0].value)} options={t.options.map(o => ({ value: o.value, label: o.label }))} />;
  if (t.kind === 'money') return <Field name="value" label={`${s.label} (₹)`} defaultValue={typeof s.value === 'number' ? String(s.value / 100) : ''} hint={t.optional ? 'Leave empty to clear.' : undefined} />;
  if (t.kind === 'text' && t.multiline) return <TextArea name="value" label={s.label} defaultValue={String(s.value ?? '')} rows={3} hint={t.optional ? 'Leave empty to clear.' : undefined} />;
  if (t.kind === 'text') return <Field name="value" label={s.label} defaultValue={String(s.value ?? '')} hint={[t.patternHint, t.optional ? 'Leave empty to clear.' : ''].filter(Boolean).join(' · ') || undefined} />;
  return null;
}
