/* Leads → Conversion (2026-10-12). Of the leads added in a period: how many reached each stage (counted from the
   recorded moves, a lead once per stage), where they stand now, and the same by source. Figures only; nothing is changed
   here. Needs leads.read. */
import type { Metadata } from 'next';
import { can } from '@kitsyuu/auth';
import { leadConversion } from '@kitsyuu/core';
import FilterForm from '@/components/FilterForm';
import ModuleViews from '@/components/ModuleViews';
import { Figures, Section, StateBlock, Workspace } from '@/components/frame';
import { Forbidden, PageHead } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { db, requireActor } from '@/lib/server';

export const metadata: Metadata = { title: 'Lead conversion' };
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const SOURCE_LABEL: Record<string, string> = { manual: 'Manual', ads: 'Ads', instagram: 'Instagram', whatsapp: 'WhatsApp', walk_in: 'Walk-in', referral: 'Referral', website: 'Website', other: 'Other' };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const back = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10); };
const real = (d: string | undefined) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 1000) / 10}%` : '—');

export default async function LeadConversionPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor();
  if (!can(actor, 'leads.read')) return <><PageHead title="Leads" /><Forbidden permission="leads.read" /></>;
  const sp = await searchParams;
  const to = real(one(sp.to)) ? one(sp.to)! : today();
  const from = real(one(sp.from)) && one(sp.from)! <= to ? one(sp.from)! : back(to, 29);
  const c = await leadConversion(db(), actor, { from, to });
  return (
    <Workspace name="leads-conversion" title="Leads pipeline" summary={`${formatNumber(c.total)} lead${c.total === 1 ? '' : 's'} added ${from} to ${to}${c.ratePct === null ? '' : ` · ${c.ratePct}% converted`}`}>
      <ModuleViews module="leads" label="Leads" current="/leads/conversion" />
      <div className="ord-toolbar">
        <FilterForm aria-label="Period" data-conversion-range>
          <label htmlFor="cv-from">From</label><input id="cv-from" name="from" type="date" className="input" defaultValue={from} max={to} />
          <label htmlFor="cv-to">To</label><input id="cv-to" name="to" type="date" className="input" defaultValue={to} />
          <button className="btn ghost" type="submit">Apply</button>
        </FilterForm>
      </div>
      {c.total === 0 ? <StateBlock title="No leads in this period" name="conversion">No lead was added between these dates. Choose a longer period.</StateBlock> : <>
        <Section id="cf-h" title="In this period" name="conversion-figures">
          <div data-conversion-figures>
            <Figures items={[{ label: 'Leads added', value: formatNumber(c.total) }, { label: 'Converted', value: formatNumber(c.converted), note: c.ratePct === null ? undefined : `${c.ratePct}% of the leads added` },
              { label: 'Disqualified', value: formatNumber(c.stages.find(s => s.stage === 'disqualified')!.now) },
              { label: 'Still open', value: formatNumber(c.total - c.converted - c.stages.find(s => s.stage === 'disqualified')!.now) }]} />
          </div>
        </Section>
        <Section id="cs-h" title="By stage" name="conversion-stages" wide hint="Reached: leads that were in that stage at some point. Now: where they stand today.">
          <div className="table-wrap"><table data-conversion-stages>
            <thead><tr><th>Stage</th><th className="num">Reached</th><th className="num">Share of leads</th><th className="num">There now</th></tr></thead>
            <tbody>{c.stages.map(s => (
              <tr key={s.stage} data-stage={s.stage}><td>{s.label}</td><td className="num" data-reached>{formatNumber(s.reached)}</td><td className="num">{pct(s.reached, c.total)}</td><td className="num" data-now>{formatNumber(s.now)}</td></tr>
            ))}</tbody>
          </table></div>
        </Section>
        <Section id="cb-h" title="By source" name="conversion-sources" wide>
          <div className="table-wrap"><table data-conversion-sources>
            <thead><tr><th>Source</th><th className="num">Leads</th><th className="num">Converted</th><th className="num">Conversion</th><th className="num">Disqualified</th></tr></thead>
            <tbody>{c.bySource.map(s => (
              <tr key={s.source} data-source={s.source}><td>{SOURCE_LABEL[s.source] ?? s.source}</td><td className="num">{formatNumber(s.leads)}</td><td className="num">{formatNumber(s.converted)}</td><td className="num">{pct(s.converted, s.leads)}</td><td className="num">{formatNumber(s.disqualified)}</td></tr>
            ))}</tbody>
          </table></div>
        </Section>
      </>}
    </Workspace>
  );
}
