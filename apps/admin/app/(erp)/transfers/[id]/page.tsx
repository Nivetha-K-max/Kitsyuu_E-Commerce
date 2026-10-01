import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getTransfer } from '@kitsyuu/core';
import { ActionForm, Field, Hidden } from '@/components/forms';
import { Forbidden, PageHead, SectionTitle, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { cancelTransferAction, receiveTransferAction, sendTransferAction } from '../actions';

export const metadata: Metadata = { title: 'Transfer' };
type Params = Promise<{ id: string }>;

export default async function TransferPage({ params }: { params: Params }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/transfers', label: 'Transfers' }];
  if (!can(actor, 'inventory.read')) return <><PageHead section="Catalogue" title="Transfer" crumbs={crumbs} /><Forbidden permission="inventory.read" /></>;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { transfer: t, lines } = await getTransfer(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const manage = can(actor, 'inventory.transfer'), units = lines.reduce((n, l) => n + l.qty, 0);
  const short = t.status === 'draft' ? lines.filter(l => l.qty > l.at_source) : [];
  return (
    <>
      <PageHead section="Catalogue" title={t.number} crumbs={crumbs} eyebrow={`${t.from_name} → ${t.to_name} · ${formatNumber(units)} unit(s) in ${lines.length} size(s)`}>
        <StatusBadge status={t.status} />
      </PageHead>
      <dl className="facts" data-transfer-meta>
        <dt>From</dt><dd><Link href={`/locations/${t.from_location_id}`}>{t.from_name}</Link></dd>
        <dt>To</dt><dd><Link href={`/locations/${t.to_location_id}`}>{t.to_name}</Link></dd>
        <dt>Created</dt><dd>{formatDateTime(t.created_at as Date)}{t.created_by ? ` · ${t.created_by}` : ''}</dd>
        {t.sent_at && <><dt>Sent</dt><dd>{formatDateTime(t.sent_at as Date)}{t.sent_by ? ` · ${t.sent_by}` : ''}</dd></>}
        {t.received_at && <><dt>Received</dt><dd>{formatDateTime(t.received_at as Date)}{t.received_by ? ` · ${t.received_by}` : ''}</dd></>}
        {t.note && <><dt>Note</dt><dd>{t.note}</dd></>}
      </dl>
      <section className="card" aria-labelledby="tl-h" data-section="transfer-lines">
        <SectionTitle id="tl-h">Sizes</SectionTitle>
        <div className="table-wrap"><table data-transfer-lines>
          <thead><tr><th>Piece</th><th>SKU</th><th className="num">Quantity</th>{t.status === 'draft' && <th className="num">At {t.from_name} now</th>}</tr></thead>
          <tbody>{lines.map(l => (
            <tr key={l.id} data-sku={l.sku}>
              <td>{l.label}</td><td className="mono">{l.sku}</td><td className="num">{l.qty}</td>
              {t.status === 'draft' && <td className="num">{l.at_source}{l.qty > l.at_source ? ' (not enough)' : ''}</td>}
            </tr>
          ))}</tbody>
        </table></div>
        {short.length > 0 && <p className="msg error" role="alert">{short.length} size(s) have less stock at {t.from_name} than this transfer sends. It cannot be sent until the stock is there.</p>}
      </section>
      {manage && (t.status === 'draft' || t.status === 'sent') && (
        <div className="actions">
          {t.status === 'draft' && (
            <ActionForm action={sendTransferAction} submitLabel="Send transfer" id="send-transfer-form" label="Send the transfer" className="inline-form"
              confirmText={`Send ${t.number}? ${units} unit(s) leave ${t.from_name} now.`}>
              <Hidden name="transferId" value={t.id} />
            </ActionForm>
          )}
          {t.status === 'sent' && (
            <ActionForm action={receiveTransferAction} submitLabel="Mark as received" id="receive-transfer-form" label="Receive the transfer" className="inline-form"
              confirmText={`Receive ${t.number}? ${units} unit(s) are added to ${t.to_name}.`}>
              <Hidden name="transferId" value={t.id} />
            </ActionForm>
          )}
        </div>
      )}
      {manage && (t.status === 'draft' || t.status === 'sent') && (
        <section className="card form-panel" aria-labelledby="tc-h" data-section="cancel-transfer">
          <h2 id="tc-h">Cancel transfer</h2>
          <ActionForm action={cancelTransferAction} submitLabel="Cancel transfer" variant="danger" id="cancel-transfer-form" label="Cancel the transfer"
            confirmText={t.status === 'sent' ? `Cancel ${t.number}? The ${units} unit(s) go back to ${t.from_name}.` : `Cancel ${t.number}? Nothing has moved yet.`}>
            <Hidden name="transferId" value={t.id} />
            <Field name="note" label="Reason" required />
          </ActionForm>
        </section>
      )}
    </>
  );
}
