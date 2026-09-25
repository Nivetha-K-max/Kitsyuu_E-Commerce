/* Promotes the account whose email is ADMIN_EMAIL (from apps/website/.env.local) to the admin role. Server-side only: this is the
   ONLY way an account becomes admin. The browser can never set profiles.role (column grants + RLS).
   Safety: the account must already exist AND its email must be confirmed, so nobody can pre-register the admin address
   without owning the inbox. Uses SUPABASE_SERVICE_ROLE_KEY (never sent to the browser). The email is never hard-coded.
   Usage (repo root): npm run db:promote-admin
   Belongs to the current Supabase Auth setup; it is retired when staff auth replaces it (M6). */
import {createClient} from '@supabase/supabase-js';

const {NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key, ADMIN_EMAIL: raw} = process.env;
if (!url || !key || /REPLACE_WITH/.test(key)) { console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local'); process.exit(1); }
const email = (raw || '').trim().toLowerCase();
if (!email || /replace_with/.test(email) || !email.includes('@')) { console.error('Set ADMIN_EMAIL in .env.local'); process.exit(1); }

const sb = createClient(url, key, {auth: {persistSession: false, autoRefreshToken: false}});
let user = null;
for (let page = 1; !user; page++) {
  const {data, error} = await sb.auth.admin.listUsers({page, perPage: 200});
  if (error) { console.error('Could not list users:', error.message); process.exit(1); }
  user = data.users.find(u => (u.email || '').toLowerCase() === email) || null;
  if (data.users.length < 200) break;
}
if (!user) { console.error(`No account found for ${email}. Sign up in the store first (and confirm the email), then run this again.`); process.exit(1); }
if (!user.email_confirmed_at) { console.error(`${email} has not confirmed its email yet. Open the confirmation link first, then run this again.`); process.exit(1); }

const {data, error} = await sb.from('profiles').update({role: 'admin'}).eq('id', user.id).select('email, role');
if (error) { console.error('Failed:', error.message); process.exit(1); }
if (!data.length) { console.error(`No profile row for ${email}.`); process.exit(1); }
console.log(`Promoted ${data[0].email} to ${data[0].role}.`);
