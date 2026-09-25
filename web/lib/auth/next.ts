/* Only same-site paths are allowed as a post-login destination (prevents open redirects).
   Shared by server pages, the email-confirmation route and the client forms. */
export const safeNext = (n?: string | null, fallback = '/account') => (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : fallback);
