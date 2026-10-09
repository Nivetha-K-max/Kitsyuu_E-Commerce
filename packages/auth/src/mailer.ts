/* Pluggable mailer. Chosen by MAILER:
   - console (default): the message (including one-time links) goes to the server's own log, never to the browser.
     Nothing is delivered: safe for development, tests and any machine that must not email real people.
   - file: each message is written to a folder (MAIL_OUTBOX_DIR) as .txt and .html, to look at what a customer would
     receive without sending anything (2026-10-08). Nothing is delivered.
   - resend: Resend's HTTP API (https://resend.com), decided 2026-09-27. Needs RESEND_API_KEY and MAIL_FROM (an address on a
     domain verified in Resend). The key never leaves the server and is never logged.
   Another provider plugs in as another Mailer.
   Every message is written as plain text; the HTML part is made from that text (mail-html.ts) unless one is given. */
import { emailHtml } from './mail-html.ts';

export interface MailMessage {
  to: string; subject: string; text: string;
  /** The HTML part; made from `text` in the KITSYUU layout when left out. */
  html?: string;
  /** The same key for the same email: a provider that supports it drops a repeat (a retry after a lost answer). */
  idempotencyKey?: string;
}
export interface Mailer { readonly kind: string; send(message: MailMessage): Promise<void> }

/** A send that failed. `transient` = worth trying again (provider unreachable, timed out, rate limited, server error);
    otherwise the provider refused the message itself (bad address, unverified sender) and a retry would fail the same way. */
export class MailError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) { super(message); this.name = 'MailError'; this.transient = transient; }
}

export function consoleMailer(write: (line: string) => void = line => process.stdout.write(line + '\n')): Mailer {
  return {
    kind: 'console',
    async send(m) {
      write(`[mail:begin] to=${m.to} subject=${JSON.stringify(m.subject)}`);
      for (const line of m.text.split('\n')) write(`[mail] ${line}`);
      write('[mail:end]');
    },
  };
}

/** Writes each message to `dir` (created if missing) as <time>-<n>-<subject>.txt and .html. Delivers nothing. */
export function fileMailer(dir: string): Mailer {
  if (!dir.trim()) throw new Error('MAIL_OUTBOX_DIR is not set (the folder MAILER=file writes messages to).');
  let n = 0;
  return {
    kind: 'file',
    async send(m) {
      // Loaded here, so nothing but this mailer needs the file system.
      const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
      fs.mkdirSync(dir, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(++n).padStart(3, '0')}-${m.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'message'}`;
      fs.writeFileSync(path.join(dir, `${name}.txt`), `To: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n`);
      fs.writeFileSync(path.join(dir, `${name}.html`), m.html ?? emailHtml(m.subject, m.text));
    },
  };
}

export interface ResendConfig { apiKey: string; from: string; replyTo?: string; apiBase?: string; timeoutMs?: number }

export function resendMailer(cfg: ResendConfig): Mailer {
  if (!/^re_[A-Za-z0-9_]{8,}$/.test(cfg.apiKey)) throw new Error('RESEND_API_KEY is not set or is not a Resend API key.');
  // "orders@example.com" or "KITSYUU <orders@example.com>"
  const address = cfg.from.trim().match(/<([^<>]+)>$/)?.[1] ?? cfg.from.trim();
  if (!/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/.test(address)) throw new Error('MAIL_FROM is not a valid sender address.');
  const base = (cfg.apiBase || 'https://api.resend.com').replace(/\/$/, '');
  return {
    kind: 'resend',
    async send(m) {
      let res: Response;
      try {
        res = await fetch(`${base}/emails`, {
          method: 'POST', signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
          headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json', ...(m.idempotencyKey ? { 'idempotency-key': m.idempotencyKey } : {}) },
          body: JSON.stringify({ from: cfg.from.trim(), to: [m.to], subject: m.subject, text: m.text, html: m.html ?? emailHtml(m.subject, m.text), ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}) }),
        });
      } catch (e) {
        throw new MailError(`Email could not be sent (Resend unreachable: ${(e as Error).name}).`, true);
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        // 409: Resend has this idempotency key in flight or already used with other content; the first send stands.
        throw new MailError(`Email could not be sent (Resend answered ${res.status}${detail ? `: ${detail}` : ''}).`, res.status === 429 || res.status >= 500);
      }
    },
  };
}

export function createMailer(kind = process.env.MAILER || 'console'): Mailer {
  if (kind === 'console') return consoleMailer();
  if (kind === 'file') return fileMailer(process.env.MAIL_OUTBOX_DIR ?? '');
  if (kind === 'resend') {
    return resendMailer({ apiKey: process.env.RESEND_API_KEY ?? '', from: process.env.MAIL_FROM ?? '', replyTo: process.env.MAIL_REPLY_TO || undefined,
      apiBase: process.env.RESEND_API_BASE || undefined });
  }
  throw new Error(`Unknown MAILER "${kind}". Use "console", "file" or "resend".`);
}
