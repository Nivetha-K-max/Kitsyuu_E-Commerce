import type { Metadata } from 'next';
import Link from 'next/link';
import { can } from '@kitsyuu/auth';
import { listBanners, promotionTargets } from '@kitsyuu/core';
import { ActionForm, Checkbox, Field, Hidden, Select, TextArea } from '@/components/forms';
import { StateBlock, Workspace } from '@/components/frame';
import { Drawer } from '@/components/overlays';
import { Forbidden, PageHead } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { istLocal } from '@/lib/erp';
import { db, requireActor } from '@/lib/server';
import { saveBannerAction, setBannerActiveAction } from '../actions';
import MarketingNav from '../MarketingNav';

export const metadata: Metadata = { title: 'Store banners' };
type Banner = Awaited<ReturnType<typeof listBanners>>[number];

function BannerFields({ b, campaigns }: { b?: Banner; campaigns: { id: string; name: string }[] }) {
  return (
    <>
      {b && <Hidden name="bannerId" value={b.id} />}
      <div className="cols">
        <Select name="placement" label="Where" defaultValue={b?.placement ?? 'home'} options={[{ value: 'home', label: 'Home page (below the hero)' }, { value: 'shop', label: 'Shop page (above the products)' }]} />
        <Field name="heading" label="Heading" defaultValue={b?.heading} required hint="Up to 80 characters." />
        <Field name="ctaLabel" label="Button label" defaultValue={b?.cta_label ?? ''} />
        <Field name="link" label="Button link" defaultValue={b?.link ?? ''} hint="A store path, e.g. /shop?collection=new-arrivals." />
        <Field name="startsAt" label="Show from (India time)" type="datetime-local" defaultValue={istLocal(b?.starts_at as Date | null)} />
        <Field name="endsAt" label="Show until (India time)" type="datetime-local" defaultValue={istLocal(b?.ends_at as Date | null)} />
        <Field name="sortOrder" label="Order" defaultValue={b ? String(b.sort_order) : ''} hint="Lower first." />
        <Select name="campaignId" label="Campaign" defaultValue={b?.campaign_id ?? ''} options={[{ value: '', label: 'None' }, ...campaigns.map(c => ({ value: c.id, label: c.name }))]} />
      </div>
      <TextArea name="body" label="Text" defaultValue={b?.body ?? ''} rows={2} hint="Optional, up to 240 characters." />
      <Checkbox name="active" label="Published" defaultChecked={b?.is_active ?? false} hint="Shown in the store only while published and inside its dates." />
    </>
  );
}

export default async function BannersPage() {
  const actor = await requireActor();
  if (!can(actor, 'marketing.read')) return <><PageHead title="Marketing" /><Forbidden permission="marketing.read" /></>;
  const [rows, targets] = await Promise.all([listBanners(db(), actor), promotionTargets(db(), actor)]);
  const manage = can(actor, 'marketing.manage');
  return (
    <Workspace name="marketing-banners" title="Marketing" summary="Promotional banners in the store. With no published banner the store looks exactly as it does now."
      actions={manage ? (
        <Drawer trigger="New banner" name="new-banner" scope="ord" title="New banner" description="Saved as a draft unless Published is ticked. It shows in the store only while published and inside its dates.">
          <ActionForm action={saveBannerAction} submitLabel="Save banner" id="create-banner-form" label="Create banner" resetOnSuccess><BannerFields campaigns={targets.campaigns} /></ActionForm>
        </Drawer>
      ) : undefined}>
      <MarketingNav current="/marketing/banners" />
      {rows.length === 0 ? <StateBlock title="No banners yet" name="banners">{manage ? 'Create a banner for the home page or the shop page.' : 'Banners appear here once they are created.'}</StateBlock> : (
        <div className="table-wrap"><table data-banners-table>
          <thead><tr><th>Banner</th><th>Where</th><th>Dates</th><th>Status</th>{manage && <th />}</tr></thead>
          <tbody>{rows.map(b => (
            <tr key={b.id} data-banner={b.heading}>
              <td><b>{b.heading}</b>{b.body && <div className="note">{b.body}</div>}{b.cta_label && <div className="note">[{b.cta_label}] → {b.link}</div>}{b.campaign_name && b.campaign_id && <div className="note">Campaign: <Link href={`/marketing/campaigns/${b.campaign_id}?tab=banners`}>{b.campaign_name}</Link></div>}</td>
              <td>{b.placement}</td><td className="note">{b.starts_at ? formatDateTime(b.starts_at as Date) : 'now'} → {b.ends_at ? formatDateTime(b.ends_at as Date) : 'no end'}</td>
              <td><span className={`badge ${b.state === 'active' ? 'active' : b.state === 'scheduled' ? 'scheduled' : 'inactive'}`}>{b.state === 'active' ? 'live' : b.state === 'inactive' ? 'draft' : b.state}</span></td>
              {manage && <td><div className="actions row-actions">
                <details className="row-edit"><summary className="btn ghost sm">Edit</summary>
                  <ActionForm action={saveBannerAction} submitLabel="Save" className="form compact row-edit-form" id={`banner-${b.id}`} label="Edit banner"><BannerFields b={b} campaigns={targets.campaigns} /></ActionForm></details>
                <ActionForm action={setBannerActiveAction} submitLabel={b.is_active ? 'Take down' : 'Publish'} variant={b.is_active ? 'danger' : 'ghost'} className="inline-form" id={`banner-active-${b.id}`} label="Publish banner">
                  <Hidden name="bannerId" value={b.id} /><Hidden name="active" value={b.is_active ? 'false' : 'true'} /></ActionForm>
              </div></td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Workspace>
  );
}
