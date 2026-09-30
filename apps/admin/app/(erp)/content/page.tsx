import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { BRAND_COPY_FIELDS, getAnnouncementAdmin, getBrandCopyAdmin } from '@kitsyuu/core';
import { ActionForm, Field, Select, TextArea } from '@/components/forms';
import { Forbidden, PageHead, SectionTitle } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { saveAnnouncementAction, saveBrandCopyAction, unpublishAnnouncementAction } from './actions';

export const metadata: Metadata = { title: 'Store content' };

/* M17: the announcement bar at the top of every store page. Drafts are private; only the published text is public. */
export default async function ContentPage() {
  const actor = await requireActor();
  if (!can(actor, 'content.manage')) return <><PageHead section="Commerce" title="Store content" /><Forbidden permission="content.manage" /></>;
  const [a, brand] = await Promise.all([getAnnouncementAdmin(db(), actor), getBrandCopyAdmin(db(), actor)]);
  const current = a.draft ?? a.published;
  return (
    <>
      <PageHead section="Commerce" title="Store content" eyebrow="The announcement bar shown at the top of every store page." />
      <div className="grid two">
        <section className="card" aria-labelledby="ann-h" data-section="announcement">
          <SectionTitle id="ann-h">Announcement bar</SectionTitle>
          <ActionForm action={saveAnnouncementAction} submitLabel="Save" id="announcement-form" label="Announcement">
            <Field name="text" label="Text" defaultValue={current?.text ?? ''} required hint="Up to 140 characters, e.g. New drop this Friday." />
            <Field name="href" label="Link (optional)" defaultValue={current?.href ?? ''} hint="A store page such as /shop?collection=new-arrivals, or https://…" />
            <Select name="publish" label="When saving" options={[{ value: 'no', label: 'Save as draft only' }, { value: 'yes', label: 'Save and publish now' }]} />
          </ActionForm>
        </section>
        <section className="card" aria-labelledby="live-h" data-section="live">
          <SectionTitle id="live-h">In the store now</SectionTitle>
          {a.published ? <>
            <p className="announce-preview" data-live-announcement>{a.published.text}{a.published.href ? ' →' : ''}</p>
            <p className="note">Published {a.publishedAt ? formatDateTime(a.publishedAt) : ''}{a.published.href ? ` · links to ${a.published.href}` : ''}</p>
            <ActionForm action={unpublishAnnouncementAction} submitLabel="Take down" variant="danger" id="unpublish-form" label="Take down the announcement"
              confirmText="Remove the announcement from the store?" />
          </> : <p className="note" data-no-announcement>Nothing is shown. Save with “publish now” to show the announcement.</p>}
        </section>
      </div>
      <section className="card form-panel" aria-labelledby="brand-h" data-section="brand-copy">
        <SectionTitle id="brand-h">Brand wording</SectionTitle>
        <p className="note">The lines that describe the brand’s origin (they mention Japan and India today). Each box shows the wording the store uses now; change it and publish. An empty box goes back to the original wording.
          {brand.updatedAt ? ` Last published ${formatDateTime(brand.updatedAt)}.` : ' Nothing has been changed yet.'}</p>
        <ActionForm action={saveBrandCopyAction} submitLabel="Publish wording" id="brand-copy-form" label="Brand wording" confirmText="Publish this wording to the store?">
          {BRAND_COPY_FIELDS.map(f => f.max > 80 || f.key === 'footerTagline'
            ? <TextArea key={f.key} name={f.key} label={f.label} rows={f.key === 'footerTagline' ? 2 : 3} defaultValue={brand.copy[f.key]} hint={`${f.where} · up to ${f.max} characters`} />
            : <Field key={f.key} name={f.key} label={f.label} defaultValue={brand.copy[f.key]} hint={`${f.where} · up to ${f.max} characters`} />)}
        </ActionForm>
      </section>
    </>
  );
}
