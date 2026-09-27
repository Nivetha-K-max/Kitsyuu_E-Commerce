/* Only same-site paths are allowed as a post-login destination (prevents open redirects).
   Shared by server pages, the email-confirmation route and the client forms. Browsers drop tabs and newlines from URLs
   and read "\" as "/", so "/\t/evil.example" or "/\evil.example" would become "//evil.example": any control character
   or backslash is refused, not only a leading "//". */
export const safeNext = (n?: string | null, fallback = '/account') =>
  (n && n.startsWith('/') && !n.startsWith('//') && !/[\\\u0000-\u001f\u007f]/.test(n) ? n : fallback);
