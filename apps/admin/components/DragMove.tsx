'use client';
/* Drag a card to another column (2026-10-12: leads board, content calendar). Native HTML drag and drop, no library.
   A drop only ASKS: it sends the same checked server action the card's own form uses (with what the page showed, so an
   out-of-date board changes nothing) and then reloads the data; the result is said in a live region. Dragging is an
   extra: every card also has an ordinary control for the same move, for keyboards and touch screens. */
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition, type DragEvent, type ReactNode } from 'react';
import type { ActionState } from '@kitsyuu/contracts';

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;
const TYPE = 'application/x-kitsyuu-card';

/** A card that can be dragged. `data` is what the drop sends along (e.g. its id and the column it is in). */
export function DragCard({ group, data, children, className, ...rest }: { group: string; data: Record<string, string>; children: ReactNode; className?: string } & Record<`data-${string}`, string | undefined>) {
  return (
    <div {...rest} className={className} draggable
      onDragStart={e => { e.dataTransfer.setData(TYPE, JSON.stringify({ group, data })); e.dataTransfer.setData('text/plain', data.label ?? ''); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.setAttribute('data-dragging', ''); }}
      onDragEnd={e => e.currentTarget.removeAttribute('data-dragging')}>
      {children}
    </div>
  );
}

/** A column that accepts cards of its group. `fields` are sent with every drop (e.g. the stage this column stands for);
    `skipWhen` names a field of the card that, when equal to this column's value, means "already here". With `noteLabel`
    the drop first asks for a short note (e.g. why a lead is disqualified). */
export function DropColumn({ group, action, fields, skipWhen, noteLabel, noteName = 'note', children, className, ...rest }: {
  group: string; action: Action; fields: Record<string, string>; skipWhen?: { card: string; equals: string };
  noteLabel?: string; noteName?: string; children: ReactNode; className?: string;
} & Record<`data-${string}`, string | undefined>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [over, setOver] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; message: string } | null>(null);
  const [asking, setAsking] = useState<Record<string, string> | null>(null);
  const depth = useRef(0);
  const send = (card: Record<string, string>, note?: string) => start(async () => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ ...card, ...fields })) if (k !== 'label') form.set(k, v);
    if (note !== undefined) form.set(noteName, note);
    const r = await action({ ok: false, message: '' }, form);
    setSaid({ ok: !!r.ok, message: r.message ?? (r.ok ? 'Moved.' : 'That could not be done.') });
    router.refresh();
  });
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(TYPE);
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!accepts(e)) return;
    e.preventDefault(); depth.current = 0; setOver(false);
    let card: { group: string; data: Record<string, string> };
    try { card = JSON.parse(e.dataTransfer.getData(TYPE)); } catch { return; }
    if (card.group !== group || (skipWhen && card.data[skipWhen.card] === skipWhen.equals)) return;
    setSaid(null);
    if (noteLabel) setAsking(card.data); else send(card.data);
  };
  return (
    <div {...rest} className={className} data-drop-over={over || undefined} data-drop-busy={pending || undefined}
      onDragEnter={e => { if (accepts(e)) { depth.current++; setOver(true); } }}
      onDragLeave={e => { if (accepts(e) && --depth.current <= 0) { depth.current = 0; setOver(false); } }}
      onDragOver={e => { if (accepts(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }} onDrop={onDrop}>
      {asking && (
        <form className="kb-ask" data-drop-ask onSubmit={e => { e.preventDefault(); const note = String(new FormData(e.currentTarget).get('n') ?? '').trim(); if (!note) return; const card = asking; setAsking(null); send(card, note); }}>
          <label>{noteLabel}{asking.label ? ` (${asking.label})` : ''}<input name="n" className="input" maxLength={300} required autoFocus /></label>
          <div className="actions"><button type="submit" className="btn sm">Move</button><button type="button" className="btn ghost sm" onClick={() => setAsking(null)}>Cancel</button></div>
        </form>
      )}
      <p className="kb-said" role="status" aria-live="polite" data-drop-said={said ? (said.ok ? 'ok' : 'refused') : undefined}>{said && !said.ok ? said.message : ''}</p>
      {children}
    </div>
  );
}
