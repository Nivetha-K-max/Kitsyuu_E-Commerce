/* Store policies shown to customers, decided by the business (2026-09-27). One place for the wording, used by the footer
   and by checkout (shown before payment). Change it here when a policy changes. */

/** Returns and refunds: none are offered (owner decision, 2026-09-27). */
export const RETURNS_POLICY = 'All sales are final. We do not accept returns or offer refunds.';

/** ERP module 3: the wording while returns are switched on in the admin (returns.enabled + returns.window_days). While
    they are off (the default) the store keeps saying RETURNS_POLICY above. */
export function returnsPolicy(s: { enabled: boolean; windowDays: number | null }): string {
  if (!s.enabled || !s.windowDays) return RETURNS_POLICY;
  return `You can request a return within ${s.windowDays} days of delivery from your order page. Each request is reviewed by our team.`;
}
