/* The fields of a campaign, shared by "New campaign" (the list) and "Edit campaign" (the campaign's page). */
import type { listCampaigns, promotionTargets } from '@kitsyuu/core';
import { Checkbox, Field, Hidden, TextArea } from '@/components/forms';
import { istLocal } from '@/lib/erp';

export type Campaign = Awaited<ReturnType<typeof listCampaigns>>[number];
export type Targets = Awaited<ReturnType<typeof promotionTargets>>;

export function CampaignFields({ c, t }: { c?: Campaign; t: Targets }) {
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

export const CAMPAIGN_STATE: Record<string, string> = { active: 'active', scheduled: 'scheduled', expired: 'inactive', inactive: 'inactive' };
