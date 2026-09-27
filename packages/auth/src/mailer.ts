/* Pluggable mailer. Chosen by MAILER:
   - console (default): the message (including one-time links) goes to the server's own log, never to the browser.
   - resend: Resend's HTTP API (https://resend.com), decided 2026-09-27. Needs RESEND_API_KEY and MAIL_FROM (an address on a
     domain verified in Resend). The key never leaves the server and is never logged.
   Another provider plugs in as another Mailer. */
export interface MailMessage { to: string; subject: string; text: string }
export interface Mailer { readonly kind: string; send(message: MailMessage): Promise<void> }

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
          headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: cfg.from.trim(), to: [m.to], subject: m.subject, text: m.text, ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}) }),
        });
      } catch (e) {
        throw new Error(`Email could not be sent (Resend unreachable: ${(e as Error).name}).`);
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`Email could not be sent (Resend answered ${res.status}${detail ? `: ${detail}` : ''}).`);
      }
    },
  };
}

export function createMailer(kind = process.env.MAILER || 'console'): Mailer {
  if (kind === 'console') return consoleMailer();
  if (kind === 'resend') {
    return resendMailer({ apiKey: process.env.RESEND_API_KEY ?? '', from: process.env.MAIL_FROM ?? '', replyTo: process.env.MAIL_REPLY_TO || undefined,
      apiBase: process.env.RESEND_API_BASE || undefined });
  }
  throw new Error(`Unknown MAILER "${kind}". Use "console" or "resend".`);
}
