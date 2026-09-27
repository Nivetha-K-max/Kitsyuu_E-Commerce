# @kitsyuu/auth

Server-only authentication and authorization shared by both apps:

- **Staff (M3):** invitations, Argon2id passwords, sessions, roles and permissions (`can`, `requirePermission`), login throttling.
- **Customers (M6):** signup with email verification, login, sessions (random token in a `__Host-` cookie; only its SHA-256 is stored), password change and reset, "sign out everywhere", and verify-on-login migration of accounts that still live in Supabase Auth.
- **Mailer interface:** `console` today (messages go to the server log); an email provider plugs in later.

Limits (session lifetimes, login attempts, link lifetimes) come from the `settings` table (`auth.*`).
