/* User-facing wording for Supabase Auth errors (codes from @supabase/auth-js). Never reveals whether an email exists
   on login; signup says so only because Supabase already signals it for that request. */
const MESSAGES: Record<string, string> = {
  invalid_credentials: 'The email or password is incorrect.',
  email_not_confirmed: 'Please confirm your email address first. Check your inbox for the KITSYUU confirmation link.',
  user_already_exists: 'An account with this email already exists. Log in instead.',
  email_exists: 'An account with this email already exists. Log in instead.',
  weak_password: 'Choose a stronger password: at least 8 characters.',
  email_address_invalid: 'Enter a valid email address.',
  validation_failed: 'Check the email and password and try again.',
  over_email_send_rate_limit: 'Too many emails were sent recently. Please wait a few minutes and try again.',
  over_request_rate_limit: 'Too many attempts. Please wait a moment and try again.',
  signup_disabled: 'New sign-ups are currently closed.',
  session_not_found: 'Your session has ended. Please log in again.',
  session_expired: 'Your session has expired. Please log in again.'
};
export function authMessage(error: { code?: string; message?: string; status?: number } | null | undefined): string {
  if (!error) return '';
  if (error.code && MESSAGES[error.code]) return MESSAGES[error.code];
  if (error.status === 0 || /fetch|network/i.test(error.message || '')) return 'We could not reach the account service. Check your connection and try again.';
  return 'Something went wrong. Please try again.';
}
