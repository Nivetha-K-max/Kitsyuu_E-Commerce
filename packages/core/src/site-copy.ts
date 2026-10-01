/* Client change request ("Japan → India: No"): the brand wording is editable by staff instead of being fixed in the code.
   The "Japan → India" route wording is removed from the defaults (2026-10-01): those lines are empty (not shown) or keep
   only their other words; "Japanese streetwear" stays, as it describes the style. Until staff publish new wording, every
   field shows its default (BRAND_COPY_DEFAULTS). Published wording is public (site_content, like the
   announcement bar); an empty field falls back to its default. */
import { recordAudit, type Db } from '@kitsyuu/db';
import { DomainError } from '@kitsyuu/contracts';
import { requirePermission, type StaffPrincipal } from '@kitsyuu/auth';
import type { MutationContext } from './staff.ts';

export const BRAND_COPY_KEY = 'store.brand_copy';
/** Where each field appears, and the store's current wording (the default). */
export const BRAND_COPY_FIELDS = [
  { key: 'metaTitle', label: 'Site title (browser tab, search results)', where: 'Every page title', max: 70, default: 'KITSYUU Store: Japanese streetwear' },
  { key: 'metaDescription', label: 'Site description (search results)', where: 'Search engines and link previews', max: 160, default: 'KITSYUU store: Japanese streetwear. Tops, bottoms and outerwear.' },
  // Was "JAPAN → INDIA" (removed with the other route wording): empty = not shown.
  { key: 'heroTop', label: 'Hero top line (right)', where: 'Home page hero, top right (empty: not shown)', max: 40, default: '' },
  // Removed at the client's request (was "KITSYUU — FROM JAPAN TO INDIA"): empty = the line is not shown; staff can add a line here.
  { key: 'heroEyebrow', label: 'Hero eyebrow', where: 'Home page hero, above the tagline (empty: not shown)', max: 60, default: '' },
  { key: 'heroLead', label: 'Hero tagline', where: 'Home page hero', max: 120, default: 'Japanese streetwear. Unconventional shapes. Made personal.' },
  { key: 'homeEyebrow', label: 'Store section eyebrow', where: 'Home page, "Shop the rotation" section', max: 60, default: 'KITSYUU STORE' },
  { key: 'homeIntro', label: 'Store section text', where: 'Home page, "Shop the rotation" section', max: 240, default: 'Japanese streetwear. Oversized shapes, washed layers and hardware details, piece by piece.' },
  { key: 'footerTagline', label: 'Footer tagline (one line per row)', where: 'Footer on every page', max: 80, default: 'JAPANESE STREETWEAR.\nINDIAN STREETS.' },
  { key: 'storyDescription', label: 'Our story page description', where: 'Our story page (search results)', max: 160, default: 'The KITSYUU story: Japanese streetwear, unconventional shapes.' },
] as const;
export type BrandCopyKey = typeof BRAND_COPY_FIELDS[number]['key'];
export type BrandCopy = Record<BrandCopyKey, string>;
export const BRAND_COPY_DEFAULTS = Object.fromEntries(BRAND_COPY_FIELDS.map(f => [f.key, f.default])) as BrandCopy;

/** Published wording merged over the defaults (anything missing or empty keeps today's text). Pure. */
export function mergeBrandCopy(published: unknown): BrandCopy {
  const o = (published ?? {}) as Record<string, unknown>;
  return Object.fromEntries(BRAND_COPY_FIELDS.map(f => {
    const v = typeof o[f.key] === 'string' ? (o[f.key] as string).trim().slice(0, f.max) : '';
    return [f.key, v || f.default];
  })) as BrandCopy;
}

export async function getBrandCopyAdmin(db: Db, actor: StaffPrincipal) {
  requirePermission(actor, 'content.manage');
  const r = await db.selectFrom('site_content').select(['content', 'updated_at']).where('key', '=', BRAND_COPY_KEY).where('locale', '=', 'en-IN').where('status', '=', 'published').executeTakeFirst();
  return { copy: mergeBrandCopy(r?.content), custom: (r?.content ?? {}) as Partial<BrandCopy>, updatedAt: (r?.updated_at as Date | undefined) ?? null };
}

/** Publishes the wording. Empty fields are not stored (they show the default). */
export async function saveBrandCopy(db: Db, actor: StaffPrincipal, input: Partial<Record<string, string>>, ctx: MutationContext) {
  requirePermission(actor, 'content.manage');
  const content: Partial<BrandCopy> = {};
  for (const f of BRAND_COPY_FIELDS) {
    const v = (input[f.key] ?? '').replace(/\r\n/g, '\n').trim();
    if (v.length > f.max) throw new DomainError('invalid', `${f.label}: keep it under ${f.max} characters.`);
    if (v && v !== f.default) content[f.key] = v;
  }
  await db.transaction().execute(async tx => {
    await tx.insertInto('site_content').values({ key: BRAND_COPY_KEY, locale: 'en-IN', status: 'published', content: JSON.stringify(content), updated_by: actor.staffId, published_at: new Date() })
      .onConflict(oc => oc.columns(['key', 'locale', 'status']).doUpdateSet({ content: JSON.stringify(content), updated_by: actor.staffId, published_at: new Date() })).execute();
    await recordAudit(tx, { actorType: 'staff', staffId: actor.staffId, action: 'content.brand_copy_publish', entityType: 'site_content', entityId: BRAND_COPY_KEY,
      after: content, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, requestId: ctx.requestId ?? null });
  });
  return { customFields: Object.keys(content).length };
}
