import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { getAnnouncementAdmin } from '@kitsyuu/core';
import { ActionForm, Field, Select } from '@/components/forms';
import { Forbidden, PageHead, SectionTitle } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { db, requireActor } from '@/lib/server';
import { saveAnnouncementAction, unpublishAnnouncementAction } from './actions';

export const metadata: Metadata = { title: 'Store content' };

/* M17: the announcement bar at the top of every store page. Drafts are private; only the published text is public. */
export default async function ContentPage() {
  const actor = await requireActor();
  if (!can(actor, 'content.manage')) return <><PageHead section="Commerce" title="Store content" /><Forbidden permission="content.manage" /></>;
  const a = await getAnnouncementAdmin(db(), actor);
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
    </>
  );
}
