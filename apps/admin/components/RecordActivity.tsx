/* The Activity tab of a record on the entity frame (2026-10-08, Purchasing and Production): the audit-log rows written
   about that record, newest first. It reads the one audit log (audit_logs) and writes nothing; the caller checks
   audit.read before rendering it. Each row is one event, in plain words, with who did it and what changed. */
import { formatDateTime, formatPaise } from '@/lib/format';
import { db } from '@/lib/server';
import { StateBlock } from './frame';

const words = (s: string) => { const t = s.replace(/[._]/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
const shown = (key: string, v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'number' && key.endsWith('_paise') ? formatPaise(v)
  : typeof v === 'object' ? (Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : '…') : String(v).length > 60 ? `${String(v).slice(0, 60)}…` : String(v));
/** Internal identifiers say nothing to staff, so they are left out of the summary. */
const hidden = (k: string) => k.endsWith('_id') || k === 'id';
function changes(b: unknown, a: unknown) {
  const before = (b ?? {}) as Record<string, unknown>, after = (a ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => !hidden(k));
  return keys.slice(0, 4).map(k => `${words(k.replace(/_paise$/, ''))}: ${k in before ? `${shown(k, before[k])} → ` : ''}${shown(k, after[k])}`).join(' · ') + (keys.length > 4 ? ` · and ${keys.length - 4} more` : '');
}

export default async function RecordActivity({ entityType, entityId, name, empty }: {
  /** audit_logs.entity_type and entity_id of the record. */
  entityType: string; entityId: string;
  /** data-activity value, for tests. */
  name: string; empty: string;
}) {
  const rows = await db().selectFrom('audit_logs as a').leftJoin('staff_users as s', 's.id', 'a.staff_id')
    .select(['a.id', 'a.occurred_at', 'a.actor_type', 'a.action', 's.email as staff_email', 'a.before_data', 'a.after_data', 'a.metadata'])
    .where('a.entity_type', '=', entityType).where('a.entity_id', '=', entityId).orderBy('a.occurred_at', 'desc').orderBy('a.id', 'desc').limit(100).execute();
  if (rows.length === 0) return <StateBlock title="No activity yet" name={`${name}-activity`}>{empty}</StateBlock>;
  return (
    <ol className="timeline" data-activity={name}>
      {rows.map(a => {
        const meta = (a.metadata ?? {}) as Record<string, unknown>;
        const said = [typeof meta.receipt_number === 'string' ? meta.receipt_number : null, typeof meta.po_number === 'string' ? meta.po_number : null,
          typeof meta.note === 'string' && meta.note ? `“${meta.note}”` : null, typeof meta.reject_reason === 'string' && meta.reject_reason ? `rejected: ${meta.reject_reason}` : null].filter(Boolean).join(' · ');
        const what = a.before_data || a.after_data ? changes(a.before_data, a.after_data) : '';
        return (
          <li key={String(a.id)} data-action={a.action}>
            <b>{words(a.action.replace(/^[a-z_]+\./, ''))}</b>
            <span className="note"> · {formatDateTime(a.occurred_at)} · {a.staff_email ?? a.actor_type}</span>
            {what && <div className="note">{what}</div>}
            {said && <div className="note">{said}</div>}
          </li>
        );
      })}
    </ol>
  );
}
