import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listFinanceNotes } from '@kitsyuu/core';
import { ActionForm, Hidden } from '@/components/forms';
import { Empty, Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { noteStatusAction } from '../actions';
import FinanceNav from '../FinanceNav';
import { Workspace } from '@/components/frame';

export const metadata: Metadata = { title: 'Credit and debit notes' };

export default async function NotesPage() {
  const actor = await requireActor();
  if (!can(actor, 'finance.read')) return <><PageHead title="Finance" /><Forbidden permission="finance.read" /></>;
  const rows = await listFinanceNotes(db(), actor);
  const manage = can(actor, 'finance.manage');
  return (
    <Workspace name="finance-notes" title="Finance" summary="Notes are raised from an invoice. A draft gets its number when it is issued.">
      <FinanceNav current="/finance/notes" />
      {rows.length === 0 ? <Empty title="No credit or debit notes" kind="finance-notes">Open an invoice to raise one.</Empty> : (
        <div className="table-wrap"><table data-notes-table>
          <thead><tr><th>Note</th><th>Invoice</th><th>Date</th><th>Reason</th><th className="num">Amount</th><th className="num">Tax</th><th>Status</th>{manage && <th />}</tr></thead>
          <tbody>{rows.map(n => (
            <tr key={n.id}><td>{n.kind} <span className="mono">{n.number ?? '(draft)'}</span></td>
              <td className="mono">{n.invoice_id ? <Link href={`/finance/invoices/${n.invoice_id}`}>{n.invoice_number}</Link> : '—'}</td>
              <td>{String(n.note_date).slice(0, 10)}</td><td>{n.reason}</td><td className="num money">{formatPaise(n.amount_paise)}</td><td className="num money">{formatPaise(n.tax_paise)}</td>
              <td><StatusBadge status={n.status} /></td>
              {manage && <td><div className="actions row-actions">
                {n.status === 'draft' && <ActionForm action={noteStatusAction} submitLabel="Issue" variant="ghost" className="inline-form" id={`issue-${n.id}`} label="Issue note" confirmText="Issue this note? Its number is final.">
                  <Hidden name="noteId" value={n.id} /><Hidden name="status" value="issued" /></ActionForm>}
                {n.status !== 'void' && <ActionForm action={noteStatusAction} submitLabel="Void" variant="danger" className="inline-form" id={`void-${n.id}`} label="Void note" confirmText="Void this note?">
                  <Hidden name="noteId" value={n.id} /><Hidden name="status" value="void" /></ActionForm>}
              </div></td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Workspace>
  );
}
