/* Bootstrap: invites a staff member from the command line (used for the first super admin, before anyone can sign in
   to the admin app). Creates an INVITED account with no password, assigns the role, and writes a one-time setup link
   to a git-ignored file. The link is not printed: open the file, use the link once, then delete the file.
   Runs with the database owner connection (server-side only) and records the invitation in the audit log.
   Usage (repo root):
     ADMIN_APP_URL=http://localhost:3002 npm run db:create-staff -- --email=someone@example.com --role=super_admin [--name="Full Name"] */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDb, recordAudit} from '@kitsyuu/db';
import {issueStaffInvite} from '@kitsyuu/auth';
import {email as emailSchema, roleCode} from '@kitsyuu/contracts';
import {connectionConfig} from './lib/connection.mjs';

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const email = emailSchema.safeParse(arg('email') ?? '');
const role = roleCode.safeParse(arg('role') ?? '');
const name = (arg('name') ?? '').trim().slice(0, 120);
const appUrl = process.env.ADMIN_APP_URL;
if (!email.success || !role.success || !appUrl) {
  console.error('Usage: ADMIN_APP_URL=<admin base url> create-staff --email=<email> --role=<role code> [--name=<name>]'); process.exit(1);
}

const cfg = connectionConfig();
const conn = `postgresql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@${cfg.host}:${cfg.port}/${encodeURIComponent(cfg.database)}`;
const db = createDb({connectionString: conn, max: 1});
try {
  const result = await db.transaction().execute(async tx => {
    const r = await tx.selectFrom('roles').select(['id', 'code']).where('code', '=', role.data).executeTakeFirst();
    if (!r) throw new Error(`Role "${role.data}" does not exist.`);
    const exists = await tx.selectFrom('staff_users').select('id').where('email', '=', email.data).executeTakeFirst();
    if (exists) throw new Error('A staff account with this email already exists. Nothing was changed.');
    const staff = await tx.insertInto('staff_users').values({email: email.data, full_name: name, status: 'invited'}).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('staff_user_roles').values({staff_user_id: staff.id, role_id: r.id, granted_by: null}).execute();
    const invite = await issueStaffInvite(tx, staff.id, null);
    await recordAudit(tx, {actorType: 'system', action: 'staff.invite', entityType: 'staff_users', entityId: staff.id,
      after: {email: email.data, full_name: name, status: 'invited', roles: [r.code]}, metadata: {via: 'create-staff script'}});
    return {staffId: staff.id, ...invite};
  });
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.local', 'invites');
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${email.data.replace(/[^a-z0-9]+/g, '_')}.txt`);
  const link = new URL(`/accept-invite?token=${encodeURIComponent(result.token)}`, appUrl).toString();
  fs.writeFileSync(file, `KITSYUU admin invitation for ${email.data} (role: ${role.data})\nOne-time link (expires ${result.expiresAt.toISOString()}):\n${link}\n\nDelete this file after using the link.\n`, {mode: 0o600});
  console.log(`Invited ${email.data} as ${role.data} (staff id ${result.staffId}, via ${cfg.via}).`);
  console.log(`One-time setup link written to ${path.relative(process.cwd(), file)} (not printed). Expires ${result.expiresAt.toISOString()}.`);
} catch (e) {
  console.error('FAILED:', e.message); process.exitCode = 1;
} finally { await db.destroy(); }
