'use server';
/* Client change request: newsletter sign-up (replaces the placeholder). Validated here and in core; stored with the consent
   wording. The answer is the same whether or not the address was already on the list. No email is sent. */
import { randomUUID } from 'node:crypto';
import { DomainError, fieldErrors, newsletterSignupInput, type ActionState } from '@kitsyuu/contracts';
import { subscribeNewsletter } from '@kitsyuu/core';
import { currentCustomer, db } from '@/lib/server';

export async function subscribeNewsletterAction(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = newsletterSignupInput.safeParse({ email: form.get('email') ?? '', consent: form.get('consent') ?? undefined, source: form.get('source') ?? undefined });
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrors(parsed.error), message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  try {
    const me = await currentCustomer().catch(() => null);
    await subscribeNewsletter(db(), { email: parsed.data.email, consent: true, source: parsed.data.source, customerId: me?.customerId ?? null });
    return { ok: true, message: 'Thanks, you are on the list. You can unsubscribe at any time from the link in our emails.' };
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message };
    const ref = randomUUID().slice(0, 8);
    console.error(`[newsletter] ref=${ref}`, e);
    return { ok: false, message: `We could not sign you up just now. Please try again. (Reference ${ref})` };
  }
}
