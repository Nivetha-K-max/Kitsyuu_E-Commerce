/* The KITSYUU email layout (2026-10-08). Every email is written once, as plain text (the wording staff and tests read,
   and the part of the message every mail app can show); this turns that text into the branded HTML part, so the two can
   never say different things and every email, old or new, looks the same without a template of its own.

   How the text is read, block by block (blocks are separated by an empty line):
     · lines starting with "- "                 → a list with the amount (the text after the last ": ") on the right
     · lines of "Label: value"                  → a table of facts; "Total…" / "Amount payable…" rows are emphasised
     · a "Label: https://…" line                → a button (the first one) or a link
     · "Items" above a list, "Deliver to" above
       an address                               → a small heading
     · anything else                            → a paragraph
   Transactional only: no images to download, no tracking pixels, no marketing. Inline styles and tables, because that is
   what mail apps support; one fluid column that reads on a phone. Everything from the message is HTML-escaped. */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const URL_RE = /^https?:\/\/[^\s<>"]+$/;
const FACT_RE = /^([A-Z][^:]{0,48}): (.+)$/;
const INK = '#16161a', MUTED = '#6b6b76', LINE = '#e7e7ea', SOFT = '#f6f6f7';
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

type Block =
  | { kind: 'list'; rows: { left: string; right: string }[] }
  | { kind: 'facts'; rows: { label: string; value: string; strong: boolean }[] }
  | { kind: 'links'; rows: { label: string; url: string }[] }
  | { kind: 'label'; text: string }
  | { kind: 'text'; lines: string[] };

function classify(lines: string[], next: string[] | undefined): Block[] {
  if (lines.every(l => l.startsWith('- '))) {
    return [{ kind: 'list', rows: lines.map(l => { const t = l.slice(2), i = t.lastIndexOf(': '); return i > 0 ? { left: t.slice(0, i), right: t.slice(i + 2) } : { left: t, right: '' }; }) }];
  }
  // A short heading line directly above a list ("Items" + the lines) or as the first line of an address ("Deliver to").
  if (lines.length > 1 && !FACT_RE.test(lines[0]!) && lines[0]!.length <= 30 && !/[.,:]$/.test(lines[0]!) && lines.slice(1).every(l => l.startsWith('- ')))
    return [{ kind: 'label', text: lines[0]! }, ...classify(lines.slice(1), next)];
  if (lines.length === 1 && lines[0]!.length <= 30 && !/[.,:!?]$/.test(lines[0]!) && !FACT_RE.test(lines[0]!) && next?.every(l => l.startsWith('- ')))
    return [{ kind: 'label', text: lines[0]! }];
  const facts = lines.map(l => FACT_RE.exec(l));
  if (facts.every(Boolean)) {
    const out: Block[] = [];
    const plain = facts.filter(m => !URL_RE.test(m![2]!)), links = facts.filter(m => URL_RE.test(m![2]!));
    if (plain.length) out.push({ kind: 'facts', rows: plain.map(m => ({ label: m![1]!, value: m![2]!, strong: /^(Total|Amount payable)/i.test(m![1]!) })) });
    if (links.length) out.push({ kind: 'links', rows: links.map(m => ({ label: m![1]!, url: m![2]! })) });
    return out;
  }
  // An address under its heading. Only the headings the emails use: any other short first line is just a paragraph.
  if (lines.length > 1 && /^(Deliver to|Delivery address|Billing address|Pick up at)$/.test(lines[0]!))
    return [{ kind: 'label', text: lines[0]! }, { kind: 'text', lines: lines.slice(1) }];
  return [{ kind: 'text', lines }];
}

/** The HTML part for a plain-text email. `subject` becomes the heading; `brand` is the name in the header and footer. */
export function emailHtml(subject: string, text: string, brand = 'KITSYUU'): string {
  const groups = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map(b => b.split('\n').map(l => l.trimEnd()).filter(l => l.length)).filter(b => b.length);
  const blocks = groups.flatMap((g, i) => classify(g, groups[i + 1]));
  let primaryUsed = false;
  const body = blocks.map(b => {
    if (b.kind === 'label') return `<tr><td style="padding:18px 0 6px;font:600 11px/1.4 ${FONT};letter-spacing:.08em;text-transform:uppercase;color:${MUTED}">${esc(b.text)}</td></tr>`;
    if (b.kind === 'list') return `<tr><td style="padding:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${b.rows.map(r =>
      `<tr><td style="padding:10px 0;border-top:1px solid ${LINE};font:400 14px/1.5 ${FONT};color:${INK}">${esc(r.left)}</td><td align="right" style="padding:10px 0 10px 16px;border-top:1px solid ${LINE};font:600 14px/1.5 ${FONT};color:${INK};white-space:nowrap">${esc(r.right)}</td></tr>`).join('')}</table></td></tr>`;
    if (b.kind === 'facts') return `<tr><td style="padding:10px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${b.rows.map(r =>
      `<tr><td style="padding:5px 16px 5px 0;font:${r.strong ? 600 : 400} ${r.strong ? 15 : 14}px/1.5 ${FONT};color:${r.strong ? INK : MUTED};vertical-align:top">${esc(r.label)}</td><td align="right" style="padding:5px 0;font:${r.strong ? 700 : 500} ${r.strong ? 15 : 14}px/1.5 ${FONT};color:${INK}">${esc(r.value)}</td></tr>`).join('')}</table></td></tr>`;
    if (b.kind === 'links') return b.rows.map(r => {
      const first = !primaryUsed; primaryUsed = true;
      return first
        ? `<tr><td style="padding:22px 0 4px"><a href="${esc(r.url)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:${INK};color:#ffffff;font:600 14px/1 ${FONT};text-decoration:none">${esc(r.label)}</a></td></tr>`
        : `<tr><td style="padding:10px 0 0;font:400 14px/1.5 ${FONT};color:${MUTED}">${esc(r.label)}: <a href="${esc(r.url)}" style="color:${INK}">${esc(r.url)}</a></td></tr>`;
    }).join('');
    return `<tr><td style="padding:10px 0 0;font:400 15px/1.6 ${FONT};color:${INK}">${b.lines.map(esc).join('<br>')}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>`
    + `<body style="margin:0;padding:0;background:${SOFT}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT}"><tr><td align="center" style="padding:24px 12px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:12px"><tr><td style="padding:24px 24px 8px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">`
    + `<tr><td style="padding:0 0 14px;border-bottom:1px solid ${LINE};font:700 15px/1 ${FONT};letter-spacing:.22em;color:${INK}">${esc(brand)}</td></tr>`
    + `<tr><td style="padding:20px 0 2px"><h1 style="margin:0;font:650 20px/1.3 ${FONT};color:${INK}">${esc(subject)}</h1></td></tr>`
    + body
    + `<tr><td style="padding:26px 0 16px"><div style="border-top:1px solid ${LINE};padding-top:14px;font:400 12px/1.5 ${FONT};color:${MUTED}">This email is about your order or account with ${esc(brand)}. It is not a marketing message.</div></td></tr>`
    + `</table></td></tr></table></td></tr></table></body></html>`;
}
