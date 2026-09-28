import type { Metadata } from 'next';
import { Fragment } from 'react';
import { can } from '@kitsyuu/auth';
import { listSettings, type SettingRow } from '@kitsyuu/core';
import { ActionForm, Field, Hidden } from '@/components/forms';
import { Forbidden, PageHead } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { updateSettingAction } from './actions';

export const metadata: Metadata = { title: 'Settings' };

function show(s: SettingRow): string {
  if (s.value === null || s.value === undefined) return 'Not set';
  if (s.type.kind === 'boolean') return s.value ? 'Yes' : 'No';
  if (s.type.kind === 'integer') return `${s.value}${s.type.unit ? ` ${s.type.unit}` : ''}`;
  if (s.type.kind === 'object' && typeof s.value === 'object')
    return Object.entries(s.value as Record<string, unknown>).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ');
  return String(s.value);
}

/* A read view of the typed settings registry. Only settings the registry marks editable get a form (one validated value,
   audited); everything else is shown with the reason it is locked. There is no free-form editor and no way to add keys. */
export default async function SettingsPage() {
  const actor = await requireActor();
  if (!can(actor, 'settings.read')) return <><PageHead section="System" title="Settings" /><Forbidden permission="settings.read" /></>;
  const { groups, unregistered, policies } = await listSettings(db(), actor);
  return (
    <>
      <PageHead section="System" title="Settings" eyebrow="Business rules are locked here; only safe operational settings can be changed, and every change is audited." />
      {groups.map(g => (
        <section className="card" key={g.group} aria-labelledby={`g-${g.group}`} data-settings-group={g.group}>
          <h2 id={`g-${g.group}`}>{g.group}</h2>
          <div className="table-wrap"><table data-settings-table>
            <thead><tr><th>Setting</th><th>Value</th><th>Change</th></tr></thead>
            <tbody>{g.items.map(s => (
              <tr key={s.key} data-setting={s.key} data-editable={s.editable ? 'yes' : 'no'}>
                <td><b>{s.label}</b><div className="note">{s.description}</div><div className="note mono">{s.key}</div></td>
                <td data-setting-value>{show(s)}{s.updatedBy && <div className="note">changed by {s.updatedBy} · {formatDateTime(s.updatedAt)}</div>}</td>
                <td>{s.canEdit && s.type.kind === 'integer' ? (
                  <ActionForm action={updateSettingAction} submitLabel="Save" pendingLabel="Saving…" label={`Change ${s.label}`} className="form inline">
                    <Hidden name="key" value={s.key} />
                    <Field name="value" label={`${s.label}${s.type.unit ? ` (${s.type.unit})` : ''}`} type="number" defaultValue={String(s.value ?? '')}
                      hint={`${s.type.min}–${s.type.max}`} />
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
