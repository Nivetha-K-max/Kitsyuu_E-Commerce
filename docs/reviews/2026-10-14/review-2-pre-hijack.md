# Review 2 — sign-up pre-account-takeover (read-only, 2026-10-14)

## Current behaviour (evidence)
* Sign-up `packages/auth/src/customer-auth.ts:58-75`: new email → row inserted WITH the submitted password_hash and full_name
  (65-67), unverified. Existing unverified email → only a new confirmation link (74); the new password computed at 61 is
  DISCARDED, the first registrant's password and name stay.
* Verify `customer-auth.ts:78-94` + `apps/website/app/verify-email/route.ts:8-25`: a plain GET consumes the token, sets
  email_verified_at, creates a session. No password re-entry, no revocation of other sessions, no change of password.
* Login `customer-auth.ts:108-147`: unverified + correct password → refused, and a NEW confirmation link is emailed (130-135).
  Verified → session.
* Reset `customer-auth.ts:180-204`: sets password, marks verified, revokes ALL sessions — safe.
* Sessions only from verify or verified login (`customer-sessions.ts:18`); unverified accounts cannot hold sessions/carts/orders
  (checkout uses `p.customerId`, `packages/core/src/checkout.ts:123`).
* Guest orders are never linked by email: account orders are `customer_id` or legacy `user_id`
  (`packages/core/src/customer-account.ts:139,186`). Guest order lookup needs order number + contact (`support-widget.ts:69-103`).
* No OAuth / magic link anywhere in apps or packages.
* Staff: invitation only (`staff-auth.ts:1-3,57-92`), reset revokes sessions (120-135). No self sign-up → no pre-hijack.
* Legacy: `apps/website/lib/legacy-auth.ts:14-31`; mirrored accounts (legacy_auth_user_id, no hash) are checked once against
  Supabase; on an UNVERIFIED account the migrated hash is stored before verification (customer-auth.ts:131).
  Mirror copies Supabase `email_confirmed_at` (20260927001400:8). Trigger `on_auth_user_created` still live (0200:24).
* Referrals: `attributeReferral` attaches a code to an unverified account created within the window (`referrals.ts:81-88`).

## Scenarios
| # | Scenario | Possible? |
|---|---|---|
| S1 | Attacker signs up victim@ with own password. Victim later signs up → gets confirm link (their password discarded) → clicks → account verified with ATTACKER's password; attacker logs in any time. | **YES** (74 + 88) |
| S2 | Attacker signs up victim@, then tries to log in → system emails victim an unsolicited "Confirm your KITSYUU account"; victim (or a corporate link scanner / Safe Links prefetch, because verify is a GET) opens it → verified with attacker's password. | **YES** (130-135 + GET route) |
| S3 | Victim uses "forgot password" instead | Safe: reset replaces password and revokes sessions (196-200). |
| S4 | Attacker keeps a session across victim verification | Not possible today: unverified accounts never get a session. |
| S5 | Attacker's pre-registration with own referral code → reward when victim later orders | Possible if victim verifies within/after window and orders (referrals.ts:85-88, 105). Low impact. |
| S6 | Attacker-chosen full_name persists on victim's account | Yes (S1/S2), cosmetic/social-engineering. |
| S7 | Legacy: attacker created a Supabase user for victim@ pre-M6 | Only matters if Supabase auto-confirmed emails (then mirrored as verified). Check with preflight query below. New Supabase sign-ups are not mirrored unless the mirror insert is re-run (do not). |
| S8 | Guest-checkout orders adopted by attacker account | Not possible (no email linking). |
| S9 | Staff invite / OAuth | N/A. |

## Proposed design (each item: change needed)
1. Verification proves knowledge of the pending password, by POST (fixes S1, S2, scanners).
   - `/verify-email` GET renders a page (no state change); POST {token, password} → `verifyCustomerEmail` checks password
     against `customers.password_hash` (+ legacy check for mirrored accounts) before setting email_verified_at.
   - Alternative (simpler UX trade-off): the link opens a "set your password" form = `resetCustomerPassword` path
     (already marks verified + revokes sessions). Signup password then unused until verify.
   - Code only (packages/auth customer-auth.ts, website verify-email route + page, contracts schema). No migration.
2. Re-registration of an UNVERIFIED email replaces the pending credentials: update password_hash, password_changed_at,
   full_name; supersede old tokens (sendLink already does, 36-37); clear pending referral attribution for that account.
   Last registrant wins, and with (1) only someone who knows that password AND reads the inbox can activate. Code only.
3. At verification: `revokeAllCustomerSessions` + mark outstanding reset/verification tokens used; audit. Code only.
4. Unverified login must not email a fresh link when the password matched (removes S2 trigger); return "unverified"
   and point to "resend confirmation". Code only.
5. Expire unverified accounts: treat an unverified account older than the verification TTL as free (step 2 covers it);
   deleting them is NOT practical: every sign-up writes an audit row and `audit_logs.customer_id` is
   `references customers on delete restrict` (20260925000900_platform.sql:59) with audit history append-only. So expire by
   neutralising instead (null password_hash/full_name, status unchanged) after N days — N is a business value (do not seed). Code (job route like apps/admin/app/api/jobs/*). Optional migration only for a partial index
   `customers (created_at) where email_verified_at is null`.
6. Referrals: attribute at verification time (store the code on the token metadata) rather than at sign-up. Code only
   (auth_tokens.metadata jsonb exists, 20260925000500:63).
7. Legacy hygiene: drop/neutralise `on_auth_user_created`, disable Supabase sign-ups in the dashboard, never re-run the mirror
   insert; see legacy-auth-plan.md.
8. One-off data review (production, read-only first):
   ```sql
   -- accounts whose password predates verification and were created by self sign-up (candidates for a forced reset)
   select count(*) from public.customers c
    where c.email_verified_at is not null and c.legacy_auth_user_id is null
      and c.password_changed_at < c.email_verified_at
      and exists (select 1 from public.audit_logs a where a.customer_id = c.id and a.action = 'customer.signup');
   -- legacy mirrored, unverified, no platform password
   select count(*) from public.customers where legacy_auth_user_id is not null and email_verified_at is null and password_hash is null;
   ```
   (audit_logs.customer_id / action confirmed in 20260925000900_platform.sql:59 and recordAudit usage). Whether to force resets is a business call.
Migration needed: none for 1–4, 6; optional index for 5.
