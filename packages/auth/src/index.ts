/* @kitsyuu/auth: server-only authentication and authorization shared by the KITSYUU apps. */
if (typeof window !== 'undefined') throw new Error('@kitsyuu/auth is server-only and must never be imported by browser code');

export { hashPassword, verifyPassword, newToken, hashToken } from './crypto.ts';
export { can, requirePermission, loadPermissions, type StaffPrincipal } from './rbac.ts';
export { createStaffSession, validateStaffSession, revokeStaffSession, revokeAllStaffSessions, type RequestContext } from './sessions.ts';
export { loginThrottle, recordLoginAttempt } from './throttle.ts';
export { authSettings, type AuthSettings } from './settings.ts';
export { consoleMailer, createMailer, type Mailer, type MailMessage } from './mailer.ts';
export {
  loginStaff, logoutStaff, issueStaffInvite, acceptStaffInvite, requestStaffPasswordReset, resetStaffPassword, changeStaffPassword,
  type LoginResult,
} from './staff-auth.ts';
