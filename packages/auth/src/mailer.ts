/* Pluggable mailer. Only the development console mailer exists until the production provider decision (M6).
   The console mailer writes the message (including one-time links) to the server's own log, never to the browser. */
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

export function createMailer(kind = process.env.MAILER || 'console'): Mailer {
  if (kind === 'console') return consoleMailer();
  throw new Error(`Unknown MAILER "${kind}". Only "console" is available until a mail provider is chosen.`);
}
