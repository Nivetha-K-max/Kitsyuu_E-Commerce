/* Marketing → Campaigns (2026-10-09: on the shared workspace frame; campaigns, their rules and actions are unchanged).
   A campaign groups the discounts and banners of a promotion. Discounts are created under Pricing & discounts and linked to
   a campaign there; a campaign only shows them. Results come from orders that used the campaign's discounts; nothing is
   estimated. Campaign emails are not sent from here (no marketing-email provider or consent is set up).
   A campaign opens on its own page: Overview · Discounts · Banners · Results. */
import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listCampaigns, promotionTargets } from '@kitsyuu/core';
import { ActionForm } from '@/components/forms';
import { StateBlock, Workspace } from '@/components/frame';
import { NavLink } from '@/components/NavFrame';
import { Drawer } from '@/components/overlays';
import { Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { saveCampaignAction } from './actions';
import { CAMPAIGN_STATE, CampaignFields } from './fields';
import MarketingNav from './MarketingNav';

export const metadata: Metadata = { title: 'Marketing' };

export default async function CampaignsPage() {
  const actor = await requireActor();
  if (!can(actor, 'marketing.read')) return <><PageHead title="Marketing" /><Forbidden permission="marketing.read" /></>;
  const manage = can(actor, 'marketing.manage');
  const [rows, targets] = await Promise.all([listCampaigns(db(), actor), manage ? promotionTargets(db(), actor) : Promise.resolve(null)]);
  const live = rows.filter(c => c.state === 'active').length;
  return (
    <Workspace name="marketing" title="Marketing" summary={`${formatNumber(rows.length)} campaign${rows.length === 1 ? '' : 's'}${live ? ` · ${formatNumber(live)} running` : ''}`}
      actions={manage && targets ? (
        <Drawer trigger="New campaign" name="new-campaign" scope="ord" title="New campaign" description="A campaign groups a promotion's discounts and banners. Link discounts to it under Pricing & discounts, and banners under Banners.">
          <ActionForm action={saveCampaignAction} submitLabel="Create campaign" id="create-campaign-form" label="Create campaign" resetOnSuccess><CampaignFields t={targets} /></ActionForm>
        </Drawer>
      ) : undefined}>
      <MarketingNav current="/marketing" />
      {rows.length === 0 ? (
        <StateBlock title="No campaigns yet" name="campaigns">{manage ? 'Create a campaign, then link discounts (Pricing & discounts) and banners to it.' : 'Campaigns appear here once they are created.'}</StateBlock>
      ) : (
        <div className="table-wrap ord-table"><table data-campaigns-table>
          <thead><tr><th>Campaign</th><th>Dates</th><th className="num">Discounts</th><th className="num">Banners</th><th className="num">Orders</th><th className="num">Revenue</th><th className="num">Discount given</th><th>Status</th></tr></thead>
          <tbody>{rows.map(c => (
            <tr key={c.id} data-campaign={c.name}>
              <td className="ord-who"><NavLink className="row-link" href={`/marketing/campaigns/${c.id}`}>{c.name}</NavLink>{c.description && <div className="note">{c.description}</div>}</td>
              <td className="note ord-extra" data-label="Dates">{c.starts_at ? formatDateTime(c.starts_at as Date) : 'now'} → {c.ends_at ? formatDateTime(c.ends_at as Date) : 'no end'}</td>
              <td className="num ord-extra" data-label="Discounts">{c.discounts}</td><td className="num ord-extra" data-label="Banners">{c.banners}</td>
              <td className="num ord-extra" data-label="Orders">{formatNumber(c.orders)}</td>
              <td className="num ord-amount">{formatPaise(c.revenue_paise)}</td><td className="num ord-extra" data-label="Discount given">{formatPaise(c.discount_paise)}</td>
              <td className="ord-stage"><span className={`badge ${CAMPAIGN_STATE[c.state] ?? 'inactive'}`}>{c.state}</span></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <p className="note section-foot">Discounts are created and linked to a campaign under <Link href="/pricing/discounts">Pricing &amp; discounts → Discounts</Link>.</p>
    </Workspace>
  );
}
