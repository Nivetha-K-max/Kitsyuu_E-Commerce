/* One customer segment (2026-10-09: on the shared entity frame; the segment and how it is worked out are unchanged).

     header  name, how many customers match now, its rules in words; Download CSV
     tabs    Customers · Rules

   A segment is a saved filter, worked out from orders and carts each time it is opened. It is a list for staff, not a
   mailing list: customers have not agreed to marketing emails through it. */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { NotFoundError } from '@kitsyuu/contracts';
import { getSegment, listSegments } from '@kitsyuu/core';
import { ActionForm, Hidden } from '@/components/forms';
import { Entity, Facts, Section, StateBlock } from '@/components/frame';
import { NavLink } from '@/components/NavFrame';
import { Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { deleteSegmentAction, saveSegmentAction } from '../../actions';
import { SegmentFields } from '../fields';
import { describeRules } from '../rules';

export const metadata: Metadata = { title: 'Segment' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const TABS = [['customers', 'Customers'], ['rules', 'Rules']] as const;
type Tab = (typeof TABS)[number][0];

export default async function SegmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/marketing/segments', label: 'Segments' }];
  if (!can(actor, 'marketing.read')) return <><PageHead title="Segment" crumbs={crumbs} /><Forbidden permission="marketing.read" /></>;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  let data;
  try { data = await getSegment(db(), actor, id); } catch (e) { if (e instanceof NotFoundError) notFound(); throw e; }
  const { segment, members } = data;
  const customers = can(actor, 'customers.read'), manage = can(actor, 'marketing.manage');
  const tab: Tab = TABS.find(t => t[0] === sp.tab)?.[0] ?? 'customers';
  const self = `/marketing/segments/${segment.id}`;
  // The saved row in the form the edit fields take (the same list the Segments view shows).
  const row = tab === 'rules' && manage ? (await listSegments(db(), actor)).find(s => s.id === segment.id) : undefined;
  const rules = describeRules(segment.rules);
  return (
    <Entity module={{ href: '/marketing/segments', label: 'Segments' }} name="segment" title={segment.name}
      factsAttr="data-segment-facts"
      facts={[{ label: 'Customers now', value: formatNumber(members.count), attr: 'members' }, { label: 'Rules', value: rules || 'None set: every customer' }]}
      actions={customers ? <a className="btn ghost sm" href={`${self}/export`} download data-segment-export>Download CSV</a> : undefined}
      tabs={TABS.map(([tid, label]) => ({ id: tid, label, count: tid === 'customers' ? members.count : undefined }))} current={tab} tabHref={t => (t === 'customers' ? self : `${self}?tab=${t}`)}
      notice={<p className="note" data-segment-note>A list for staff, not a mailing list: customers have not agreed to marketing emails through this list.</p>}>

      {tab === 'customers' && (
        <Section id="sm-h" title="Customers who match now" name="members" wide meta={members.count ? formatNumber(members.count) : undefined} hint="Worked out from orders and carts when this page opens.">
          {members.rows.length === 0 ? <StateBlock title="No customers match right now" name="segment-members">Change the rules, or look again later.</StateBlock> : (
            <div className="table-wrap"><table data-segment-members>
              <thead><tr><th>Customer</th><th className="num">Paid orders</th><th className="num">Spent</th><th>Last order</th><th>Joined</th></tr></thead>
              <tbody>{members.rows.map(m => (
                <tr key={m.id}><td>{customers ? <NavLink className="row-link" href={`/customers/${m.id}`}>{m.email}</NavLink> : m.email}{m.full_name && <div className="note">{m.full_name}</div>}</td>
                  <td className="num">{m.orders}</td><td className="num money">{formatPaise(m.spent_paise)}</td>
                  <td className="nowrap">{formatDateTime(m.last_order_at as Date | null)}</td><td className="nowrap">{formatDateTime(m.created_at as Date)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Section>
      )}

      {tab === 'rules' && <>
        {manage && row ? (
          <Section id="sr-h" title="Rules" name="rules" hint="Customers matching ALL the rules that are filled in.">
            <ActionForm action={saveSegmentAction} submitLabel="Save" id={`segment-${segment.id}`} label="Edit segment"><SegmentFields s={row} /></ActionForm>
          </Section>
        ) : (
          <Section id="sr-h" title="Rules" name="rules">
            <Facts items={[{ label: 'Name', value: segment.name }, { label: 'Rules', value: rules || 'None set: every customer' }]} />
            <p className="note" data-readonly="segment">Changing a segment needs the marketing.manage permission.</p>
          </Section>
        )}
        {manage && (
          <Section id="sd-h" title="Delete segment" name="delete-segment" hint="Only the saved filter is removed. Customers are not affected.">
            <ActionForm action={deleteSegmentAction} submitLabel="Delete" variant="danger" className="inline-form" id={`segment-del-${segment.id}`} label="Delete segment" confirmText={`Delete the segment "${segment.name}"? Customers are not affected.`}>
              <Hidden name="segmentId" value={segment.id} /></ActionForm>
          </Section>
        )}
      </>}
    </Entity>
  );
}
