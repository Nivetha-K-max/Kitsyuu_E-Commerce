import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listCampaigns, promotionTargets } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Hidden, TextArea } from '@/components/forms';
import { Empty, Forbidden, PageHead } from '@/components/ui';
import { formatDateTime, formatNumber, formatPaise } from '@/lib/format';
import { istLocal } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { saveCampaignAction, setCampaignActiveAction } from './actions';
import MarketingNav from './MarketingNav';

export const metadata: Metadata = { title: 'Marketing' };
type Campaign = Awaited<ReturnType<typeof listCampaigns>>[number];
type Targets = Awaited<ReturnType<typeof promotionTargets>>;

function CampaignFields({ c, t }: { c?: Campaign; t: Targets }) {
  return (
    <>
      {c && <Hidden name="campaignId" value={c.id} />}
      <Field name="name" label="Name" defaultValue={c?.name} required />
      <TextArea name="description" label="Description (staff only)" defaultValue={c?.description ?? ''} rows={2} />
      <div className="cols">
        <Field name="startsAt" label="Starts (India time)" type="datetime-local" defaultValue={istLocal(c?.starts_at as Date | null)} />
        <Field name="endsAt" label="Ends (India time)" type="datetime-local" defaultValue={istLocal(c?.ends_at as Date | null)} />
      </div>
      <details><summary className="btn ghost sm">Products ({c?.product_ids.length ?? 0})</summary>
        <div className="check-grid">{t.products.map(p => <label key={p.id} className="check"><input type="checkbox" name="productIds[]" value={p.id} defaultChecked={c?.product_ids.includes(p.id)} /><span>{p.name}</span></label>)}</div></details>
      <details><summary className="btn ghost sm">Collections ({c?.collection_ids.length ?? 0})</summary>
        <div className="check-grid">{t.collections.map(x => <label key={x.id} className="check"><input type="checkbox" name="collectionIds[]" value={x.id} defaultChecked={c?.collection_ids.includes(x.id)} /><span>{x.label}</span></label>)}</div></details>
      <Checkbox name="active" label="Active" defaultChecked={c?.is_active ?? true} />
    </>
  );
}

/* ERP module 4: campaigns group the discounts (Pricing → Discounts → Campaign) and banners of a promotion. Results come
   from orders that used the campaign's discounts; nothing is estimated. */
export default async function CampaignsPage() {
  const actor = await requireActor();
  if (!can(actor, 'marketing.read')) return <><PageHead title="Marketing" /><Forbidden permission="marketing.read" /></>;
  const [rows, targets] = await Promise.all([listCampaigns(db(), actor), promotionTargets(db(), actor)]);
  const manage = can(actor, 'marketing.manage');
  return (
    <>
      <PageHead title="Marketing" eyebrow="Campaigns, store banners and customer segments. Campaign emails are not sent from here (no marketing-email provider or consent is set up)." />
      <MarketingNav current="/marketing" />
      {rows.length === 0 ? <Empty title="No campaigns yet" kind="campaigns">Create a campaign, then link discounts (Pricing) and banners to it.</Empty> : (
        <div className="table-wrap"><table data-campaigns-table>
          <thead><tr><th>Campaign</th><th>Dates</th><th className="num">Discounts</th><th className="num">Banners</th><th className="num">Orders</th><th className="num">Revenue</th><th className="num">Discount given</th><th>Status</th>{manage && <th />}</tr></thead>
          <tbody>{rows.map(c => (
            <tr key={c.id} data-campaign={c.name}>
              <td><b>{c.name}</b>{c.description && <div className="note">{c.description}</div>}</td>
              <td className="note">{c.starts_at ? formatDateTime(c.starts_at as Date) : 'now'} → {c.ends_at ? formatDateTime(c.ends_at as Date) : 'no end'}</td>
              <td className="num">{c.discounts}</td><td className="num">{c.banners}</td><td className="num">{formatNumber(c.orders)}</td>
              <td className="num money">{formatPaise(c.revenue_paise)}</td><td className="num money">{formatPaise(c.discount_paise)}</td>
              <td><span className={`badge ${c.state === 'active' ? 'active' : c.state === 'scheduled' ? 'scheduled' : 'inactive'}`}>{c.state}</span></td>
              {manage && <td><div className="actions row-actions">
                <details className="row-edit"><summary className="btn ghost sm">Edit</summary>
                  <ActionForm action={saveCampaignAction} submitLabel="Save" className="form compact row-edit-form" id={`campaign-${c.id}`} label="Edit campaign"><CampaignFields c={c} t={targets} /></ActionForm></details>
                <ActionForm action={setCampaignActiveAction} submitLabel={c.is_active ? 'Pause' : 'Activate'} variant="ghost" className="inline-form" id={`campaign-active-${c.id}`} label="Switch campaign">
                  <Hidden name="campaignId" value={c.id} /><Hidden name="active" value={c.is_active ? 'false' : 'true'} /></ActionForm>
              </div></td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <p className="note">Link a discount to a campaign under <Link href="/pricing/discounts">Pricing → Discounts</Link>.</p>
      {manage && <section className="card form-panel" aria-labelledby="nc-h"><h2 id="nc-h">New campaign</h2>
        <ActionForm action={saveCampaignAction} submitLabel="Create campaign" id="create-campaign-form" label="Create campaign" resetOnSuccess><CampaignFields t={targets} /></ActionForm></section>}
    </>
  );
}
