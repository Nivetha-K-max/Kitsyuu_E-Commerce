/* The help window's two features for visitors who are NOT signed in (2026-10-12): looking an order up by its number and
   contact, and sending a message. Both are open to anyone on the internet, so they are only offered where request limits
   are really counted.
   Rule: on a production deployment with no rate limiter configured, both are CLOSED. The help topics and a signed-in
   customer's own messages are not affected. Outside a deployment (local development, tests) they stay open, unless
   HELP_GUEST_REQUIRES_LIMITER=on asks for the production rule there too.
   "Configured" means the limiter's address and token are set and usable. This file does not check that the limiter
   answers, and nothing here says limits are active: it only refuses to open the two features without one.
   Pure on purpose (no server imports), so the rule can be tested by itself. */
export type GuestHelpInput = { /** a production deployment */ deployed: boolean; /** a rate limiter is configured */ limiterConfigured: boolean; /** apply the production rule here as well */ required: boolean };

export function guestHelpOpen(i: GuestHelpInput): boolean {
  return i.limiterConfigured || !(i.deployed || i.required);
}

export const GUEST_LOOKUP_CLOSED = 'Checking an order here is not available right now. Sign in to see your orders under My account.';
export const GUEST_MESSAGE_CLOSED = 'Please sign in to send us a message. Messages from visitors who are not signed in are not being accepted right now.';
