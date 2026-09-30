'use client';
/* Tag picker (client change request): chosen values as chips, and "+ Add" opens a searchable list of the others. The
   chosen values are posted as hidden inputs named `name` (e.g. "values[]"), so the server action receives exactly what is
   shown; the server checks everything again. Deactivated values stay as chips when already chosen but cannot be added.
   single: one value at most (choosing another replaces it). */
import { useId, useMemo, useRef, useState } from 'react';

export type TagOption = { value: string; label: string; swatch?: string | null; inactive?: boolean };

export default function TagPicker({ name, label, options, selected, single = false, addLabel = '+ Add', hint }: {
  name: string; label: string; options: TagOption[]; selected: string[]; single?: boolean; addLabel?: string; hint?: string;
}) {
  const [chosen, setChosen] = useState<string[]>(selected);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const id = useId();
  const search = useRef<HTMLInputElement>(null);
  const byValue = useMemo(() => new Map(options.map(o => [o.value, o])), [options]);
  const choices = options.filter(o => !o.inactive && !chosen.includes(o.value) && o.label.toLowerCase().includes(q.trim().toLowerCase()));
  const add = (v: string) => { setChosen(c => (single ? [v] : [...c, v])); setQ(''); if (single) setOpen(false); else search.current?.focus(); };
  const remove = (v: string) => setChosen(c => c.filter(x => x !== v));
  const dot = (o?: TagOption) => o?.swatch ? <span className="tag-swatch" style={{ background: o.swatch }} aria-hidden="true" /> : null;
  return (
    <fieldset className="tag-picker" data-tag-picker={name}>
      <legend>{label}{single && <span className="note"> · one value</span>}</legend>
      <div className="tag-row">
        {chosen.map(v => {
          const o = byValue.get(v);
          return (
            <span key={v} className={`tag${o?.inactive ? ' is-inactive' : ''}`} data-tag={v}>
              {dot(o)}<b>{o?.label ?? v}</b>{o?.inactive && <span className="note"> (deactivated)</span>}
              <button type="button" aria-label={`Remove ${o?.label ?? v}`} onClick={() => remove(v)}>×</button>
              <input type="hidden" name={name} value={v} />
            </span>
          );
        })}
        {!chosen.length && <span className="note tag-none">None</span>}
        <button type="button" className="btn ghost sm tag-add" aria-expanded={open} aria-controls={`${id}-list`}
          onClick={() => { setOpen(o => !o); setTimeout(() => search.current?.focus(), 0); }}>{addLabel}</button>
      </div>
      {open && (
        <div className="tag-pop" id={`${id}-list`}>
          <input ref={search} className="input" type="search" placeholder="Search…" aria-label={`Search ${label}`} value={q}
            onChange={e => setQ(e.currentTarget.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); if (choices[0]) add(choices[0].value); }
              if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
            }} />
          <div className="tag-options" role="listbox" aria-label={label}>
            {choices.length ? choices.map(o => (
              <button type="button" role="option" aria-selected="false" key={o.value} className="tag-option" data-option={o.value} onClick={() => add(o.value)}>{dot(o)}{o.label}</button>
            )) : <p className="note">{q ? `Nothing matches “${q}”.` : 'Everything is already chosen.'}</p>}
          </div>
        </div>
      )}
      {hint && <p className="note">{hint}</p>}
    </fieldset>
  );
}
