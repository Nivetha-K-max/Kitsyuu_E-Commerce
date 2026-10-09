/* One stock transfer (2026-10-09: on the shared entity frame; the transfer, its steps and its actions are unchanged).

     header  number, status, from → to, how many units; the next step (Send, or Mark as received)
     tabs    Sizes · Activity

   Draft → sent (the units leave the sender) → received (they arrive) or cancelled (a sent transfer's units go back).
   Every step writes the stock ledger; nothing on this page changes a quantity itself. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getTransfer } from '@kitsyuu/core';
import { ActionForm, Field, Hidden } from '@/components/forms';
import { Entity, Facts, Section } from '@/components/frame';
import RecordActivity from '@/components/RecordActivity';
import { Forbidden, PageHead, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { cancelTransferAction, receiveTransferAction, sendTransferAction } from '../actions';

export const metadata: Metadata = { title: 'Transfer' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
const TABS = [['sizes', 'Sizes'], ['activity', 'Activity']] as const;
type Tab = (typeof TABS)[number][0];

export default async function TransferPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/transfers', label: 'Transfers' }];
  if (!can(actor, 'inventory.read')) return <><PageHead section="Catalogue" title="Transfer" crumbs={crumbs} /><Forbidden permission="inventory.read" /></>;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { transfer: t, lines } = await getTransfer(db(), actor, id).catch(e => { if (e instanceof NotFoundError) notFound(); throw e; });
  const manage = can(actor, 'inventory.transfer'), units = lines.reduce((n, l) => n + l.qty, 0);
  const short = t.status === 'draft' ? lines.filter(l => l.qty > l.at_source) : [];
  const open = t.status === 'draft' || t.status === 'sent';
  const tabs = TABS.filter(x => x[0] !== 'activity' || can(actor, 'audit.read'));
  const tab: Tab = tabs.find(x => x[0] === sp.tab)?.[0] ?? 'sizes';
  const self = `/transfers/${t.id}`;
  return (
    <Entity module={{ href: '/transfers', label: 'Transfers' }} name="transfer" title={t.number} status={<StatusBadge status={t.status} />}
      factsAttr="data-transfer-facts"
      facts={[
        { label: 'From', value: <Link href={`/locations/${t.from_location_id}`}>{t.from_name}</Link> },
        { label: 'To', value: <Link href={`/locations/${t.to_location_id}`}>{t.to_name}</Link> },
        { label: 'Units', value: `${formatNumber(units)} in ${lines.length} size${lines.length === 1 ? '' : 's'}`, attr: 'units' },
      ]}
      actions={manage && open ? <div className="ord-head-actions">
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
      </div> : undefined}
      tabs={tabs.map(([tid, label]) => ({ id: tid, label, count: tid === 'sizes' ? lines.length : undefined }))} current={tab} tabHref={x => (x === 'sizes' ? self : `${self}?tab=${x}`)}>

      {tab === 'sizes' && <>
        <Section id="tl-h" title="Sizes" name="transfer-lines" wide hint={t.status === 'draft' ? 'A draft: nothing has moved yet.' : undefined}>
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
        </Section>
        <Section id="td-h" title="Transfer" name="transfer-details">
          <Facts attr="data-transfer-meta" items={[
            { label: 'From', value: <Link href={`/locations/${t.from_location_id}`}>{t.from_name}</Link> },
            { label: 'To', value: <Link href={`/locations/${t.to_location_id}`}>{t.to_name}</Link> },
            { label: 'Created', value: `${formatDateTime(t.created_at as Date)}${t.created_by ? ` · ${t.created_by}` : ''}` },
            ...(t.sent_at ? [{ label: 'Sent', value: `${formatDateTime(t.sent_at as Date)}${t.sent_by ? ` · ${t.sent_by}` : ''}` }] : []),
            ...(t.received_at ? [{ label: 'Received', value: `${formatDateTime(t.received_at as Date)}${t.received_by ? ` · ${t.received_by}` : ''}` }] : []),
            ...(t.note ? [{ label: 'Note', value: t.note }] : []),
            // What this transfer wrote to the stock ledger (nothing while it is a draft).
            ...(t.status !== 'draft' ? [{ label: 'Stock ledger', value: <Link href={`/inventory/movements?q=${encodeURIComponent(t.number)}`} data-link="transfer-movements">Movements of {t.number}</Link> }] : []),
          ]} />
        </Section>
        {manage && open && (
          <Section id="tc-h" title="Cancel transfer" name="cancel-transfer" hint={t.status === 'sent' ? `The ${units} unit(s) go back to ${t.from_name}.` : 'Nothing has moved yet.'}>
            <ActionForm action={cancelTransferAction} submitLabel="Cancel transfer" variant="danger" id="cancel-transfer-form" label="Cancel the transfer"
              confirmText={t.status === 'sent' ? `Cancel ${t.number}? The ${units} unit(s) go back to ${t.from_name}.` : `Cancel ${t.number}? Nothing has moved yet.`}>
              <Hidden name="transferId" value={t.id} />
              <Field name="note" label="Reason" required />
            </ActionForm>
          </Section>
        )}
      </>}

      {tab === 'activity' && (
        <Section id="ta-h" title="Activity" name="activity" wide hint="Every step of this transfer, from the audit log.">
          <RecordActivity entityType="stock_transfers" entityId={t.id} name="transfer" empty="Changes to this transfer are listed here as they are made." />
        </Section>
      )}
    </Entity>
  );
}
