/* @kitsyuu/auth: server-only authentication and authorization shared by the KITSYUU apps. */
if (typeof window !== 'undefined') throw new Error('@kitsyuu/auth is server-only and must never be imported by browser code');

export { hashPassword, verifyPassword, newToken, hashToken } from './crypto.ts';
export { can, requirePermission, loadPermissions, type StaffPrincipal } from './rbac.ts';
export { createStaffSession, validateStaffSession, revokeStaffSession, revokeAllStaffSessions, type RequestContext } from './sessions.ts';
export { loginThrottle, recordLoginAttempt } from './throttle.ts';
export { authSettings, type AuthSettings } from './settings.ts';
export { consoleMailer, createMailer, fileMailer, resendMailer, MailError, type Mailer, type MailMessage, type ResendConfig } from './mailer.ts';
export { emailHtml } from './mail-html.ts';
export {
  loginStaff, logoutStaff, issueStaffInvite, acceptStaffInvite, requestStaffPasswordReset, resetStaffPassword, changeStaffPassword,
  type LoginResult,
} from './staff-auth.ts';
export {
  createCustomerSession, validateCustomerSession, revokeCustomerSession, revokeAllCustomerSessions, listCustomerSessions,
  type CustomerPrincipal, type CustomerSessionInfo,
} from './customer-sessions.ts';
export {
  signupCustomer, verifyCustomerEmail, resendCustomerVerification, loginCustomer, logoutCustomer, logoutCustomerEverywhere,
  endCustomerSession, requestCustomerPasswordReset, resetCustomerPassword, changeCustomerPassword,
  type CustomerLoginResult, type LegacyPasswordCheck,
} from './customer-auth.ts';
// ---------- M18: staff two-factor sign-in ----------
export { totpAt, verifyTotp, currentStep, base32Encode, base32Decode, mfaKey, encryptSecret, decryptSecret, otpauthUri, newRecoveryCodes } from './mfa.ts';
export { staffMfaStatus, startStaffMfa, confirmStaffMfa, disableStaffMfa, removeStaffMfa, checkSecondFactor } from './staff-mfa.ts';
