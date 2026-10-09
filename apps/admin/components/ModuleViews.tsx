/* The row of views of a module workspace whose views are separate pages (Inventory: Stock · Locations · Transfers ·
   Stock counts · Stock value). It comes from lib/nav.ts, the same list the sidebar is built from, and shows only the
   views this person may open. One view alone needs no row. */
import { can } from '@kitsyuu/auth';
import { moduleViews } from '@/lib/nav';
import { requireActor } from '@/lib/server';
import SubNav from './SubNav';

export default async function ModuleViews({ module: id, current, label }: { module: string; current: string; label: string }) {
  const actor = await requireActor();
  const views = moduleViews(id, p => can(actor, p));
  if (views.length < 2) return null;
  return <SubNav label={`${label} views`} current={current} items={views.map(v => ({ href: v.href, label: v.label }))} module={id} />;
}
