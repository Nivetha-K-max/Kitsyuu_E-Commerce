/* One campaign (2026-10-09: on the shared entity frame).

     header  name, running / scheduled / ended, its dates; Pause or Activate
     tabs    Overview · Discounts · Banners · Results

   A campaign is the existing record (campaigns); nothing new is stored. Its discounts are the discounts linked to it under
   Pricing & discounts (created and changed there, only listed here); its banners are the banners linked to it under
   Marketing → Banners. Results are orders that used the campaign's discounts, from recorded redemptions: nothing is estimated. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@kitsyuu/auth';
import { listBanners, listCampaigns, promotionTargets } from '@kitsyuu/core';
import { ActionForm, Hidden } from '@/components/forms';
import { Entity, Facts, Figures, Section, StateBlock } from '@/components/frame';
import { Drawer } from '@/components/overlays';
import RecordActivity from '@/components/RecordActivity';
import { Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { saveCampaignAction, setCampaignActiveAction } from '../../actions';
import { CAMPAIGN_STATE, CampaignFields } from '../../fields';

export const metadata: Metadata = { title: 'Campaign' };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;
const TABS = [['overview', 'Overview'], ['discounts', 'Discounts'], ['banners', 'Banners'], ['results', 'Results'], ['activity', 'Activity']] as const;
type Tab = (typeof TABS)[number][0];

export default async function CampaignPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const actor = await requireActor();
  const crumbs = [{ href: '/marketing', label: 'Marketing' }];
  if (!can(actor, 'marketing.read')) return <><PageHead title="Campaign" crumbs={crumbs} /><Forbidden permission="marketing.read" /></>;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const c = (await listCampaigns(db(), actor)).find(x => x.id === id);
  if (!c) notFound();
  const manage = can(actor, 'marketing.manage'), seePricing = can(actor, 'pricing.read');
  const tabs = TABS.filter(t => t[0] !== 'activity' || can(actor, 'audit.read'));
  const tab: Tab = tabs.find(t => t[0] === sp.tab)?.[0] ?? 'overview';
  const self = `/marketing/campaigns/${c.id}`;
  const targets = manage ? await promotionTargets(db(), actor) : null;
  // The campaign's own discounts and banners (read-only here).
  const discounts = tab === 'discounts' ? await db().selectFrom('discounts').select(['id', 'name', 'code', 'is_active', 'starts_at', 'ends_at'])
    .where('campaign_id', '=', c.id).orderBy('created_at', 'desc').execute() : [];
  const banners = tab === 'banners' ? (await listBanners(db(), actor)).filter(b => b.campaign_id === c.id) : [];
  const dates = `${c.starts_at ? formatDateTime(c.starts_at as Date) : 'now'} → ${c.ends_at ? formatDateTime(c.ends_at as Date) : 'no end'}`;

  return (
    <Entity module={{ href: '/marketing', label: 'Marketing' }} name="campaign" title={c.name}
      status={<span className={`badge ${CAMPAIGN_STATE[c.state] ?? 'inactive'}`} data-campaign-state>{c.state}</span>}
      factsAttr="data-campaign-facts"
      facts={[{ label: 'Dates', value: dates }, { label: 'Discounts', value: String(c.discounts), attr: 'discounts' }, { label: 'Banners', value: String(c.banners), attr: 'banners' }]}
      actions={manage ? <div className="ord-head-actions">
        {targets && (
          <Drawer trigger="Edit campaign" triggerClass="btn ghost sm" name="edit-campaign" scope="ord" title={`Edit ${c.name}`}>
            <ActionForm action={saveCampaignAction} submitLabel="Save" id={`campaign-${c.id}`} label="Edit campaign"><CampaignFields c={c} t={targets} /></ActionForm>
          </Drawer>
        )}
        <ActionForm action={setCampaignActiveAction} submitLabel={c.is_active ? 'Pause' : 'Activate'} variant={c.is_active ? 'ghost' : undefined} className="inline-form ent-quick" id={`campaign-active-${c.id}`} label="Switch campaign">
          <Hidden name="campaignId" value={c.id} /><Hidden name="active" value={c.is_active ? 'false' : 'true'} />
        </ActionForm>
      </div> : undefined}
      tabs={tabs.map(([tid, label]) => ({ id: tid, label, count: tid === 'discounts' ? c.discounts : tid === 'banners' ? c.banners : undefined }))} current={tab} tabHref={t => (t === 'overview' ? self : `${self}?tab=${t}`)}>

      {tab === 'overview' && <>
        <Section id="co-h" title="Campaign" name="campaign">
          <Facts attr="data-campaign-details" items={[
            { label: 'Name', value: c.name }, { label: 'Description (staff only)', value: c.description ?? '—' }, { label: 'Runs', value: dates },
            { label: 'Switched on', value: c.is_active ? 'Yes' : 'No (paused)' },
            { label: 'Products named', value: formatNumber(c.product_ids.length) }, { label: 'Collections named', value: formatNumber(c.collection_ids.length) },
            { label: 'Created', value: formatDateTime(c.created_at as Date) },
          ]} />
        </Section>
        <Section id="cs-h" title="So far" name="summary" hint="From orders that used this campaign's discounts.">
          <Figures items={[{ label: 'Orders', value: formatNumber(c.orders) }, { label: 'Revenue', value: formatPaise(c.revenue_paise) }, { label: 'Discount given', value: formatPaise(c.discount_paise) }]} />
        </Section>
        {!manage && <p className="note" data-readonly="campaign">Changing a campaign needs the marketing.manage permission.</p>}
      </>}

      {tab === 'discounts' && (
        <Section id="cd-h" title="Discounts of this campaign" name="discounts" wide meta={discounts.length ? `${discounts.length}` : undefined}
          hint={<>Discounts are created and linked to a campaign under {seePricing ? <Link href="/pricing/discounts" data-link="pricing-discounts">Pricing &amp; discounts → Discounts</Link> : 'Pricing & discounts → Discounts'} (choose this campaign in the discount&apos;s form). They are only listed here.</>}>
          {discounts.length === 0 ? <StateBlock title="No discount is linked to this campaign" name="campaign-discounts">Open a discount under Pricing &amp; discounts and choose this campaign.</StateBlock> : (
            <div className="table-wrap"><table data-campaign-discounts>
              <thead><tr><th>Discount</th><th>Code</th><th>Dates</th><th>Status</th></tr></thead>
              <tbody>{discounts.map(d => (
                <tr key={d.id} data-discount={d.name}><td><b>{d.name}</b></td><td className="mono">{d.code ?? 'automatic'}</td>
                  <td className="note">{d.starts_at ? formatDateTime(d.starts_at as Date) : 'now'} → {d.ends_at ? formatDateTime(d.ends_at as Date) : 'no end'}</td>
                  <td><span className={`badge ${d.is_active ? 'active' : 'inactive'}`}>{d.is_active ? 'active' : 'inactive'}</span></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Section>
      )}

      {tab === 'banners' && (
        <Section id="cb-h" title="Banners of this campaign" name="banners" wide meta={banners.length ? `${banners.length}` : undefined}
          hint={<>Banners are created and linked to a campaign under <Link href="/marketing/banners" data-link="marketing-banners">Marketing → Banners</Link>.</>}>
          {banners.length === 0 ? <StateBlock title="No banner is linked to this campaign" name="campaign-banners">Open a banner under Marketing → Banners and choose this campaign.</StateBlock> : (
            <div className="table-wrap"><table data-campaign-banners>
              <thead><tr><th>Banner</th><th>Where</th><th>Dates</th><th>Status</th></tr></thead>
              <tbody>{banners.map(b => (
                <tr key={b.id} data-banner={b.heading}><td><b>{b.heading}</b>{b.body && <div className="note">{b.body}</div>}</td><td>{b.placement}</td>
                  <td className="note">{b.starts_at ? formatDateTime(b.starts_at as Date) : 'now'} → {b.ends_at ? formatDateTime(b.ends_at as Date) : 'no end'}</td>
                  <td><span className={`badge ${b.state === 'active' ? 'active' : b.state === 'scheduled' ? 'scheduled' : 'inactive'}`}>{b.state === 'active' ? 'live' : b.state === 'inactive' ? 'draft' : b.state}</span></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Section>
      )}

      {tab === 'results' && (
        <Section id="cr-h" title="Results" name="results" wide hint="Paid, processing, shipped and delivered orders that used one of this campaign's discounts, from recorded redemptions. Nothing is estimated.">
          <div data-campaign-results><Figures items={[
            { label: 'Orders', value: formatNumber(c.orders) }, { label: 'Revenue', value: formatPaise(c.revenue_paise), note: 'total of those orders' },
            { label: 'Discount given', value: formatPaise(c.discount_paise) }]} /></div>
          <p className="note">Per discount and per period: <Link href="/marketing/report" data-link="promotion-report">Marketing → Report</Link>.</p>
        </Section>
      )}

      {tab === 'activity' && (
        <Section id="ca-h" title="Activity" name="activity" wide hint="Changes to this campaign, from the audit log.">
          <RecordActivity entityType="campaigns" entityId={c.id} name="campaign" empty="Changes to this campaign are listed here as they are made." />
        </Section>
      )}
    </Entity>
  );
}
