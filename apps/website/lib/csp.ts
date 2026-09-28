/* M9: the storefront Content-Security-Policy, built in one place. The browser may only load from this origin, product
   images from Supabase Storage and, on checkout pages, the payment provider's checkout script, frames and API.
   Checkout pages get their policy at request time (proxy.ts), so the payment origins follow RAZORPAY_CHECKOUT_URL /
   RAZORPAY_API_BASE when a deployment (or the test suite's stand-in) sets them; every other page gets it from
   next.config.ts. Development adds what the Next.js dev server needs (eval, websocket); production never gets them. */
const origin = (u: string | undefined, fallback: string) => { try { return u ? new URL(u).origin : fallback; } catch { return fallback; } };

export function storefrontCsp(opts: { dev: boolean; payments?: { checkoutScriptUrl?: string; apiBase?: string } }): string {
  const pay = opts.payments
    ? [origin(opts.payments.checkoutScriptUrl, 'https://checkout.razorpay.com'), origin(opts.payments.apiBase, 'https://api.razorpay.com')]
    : [];
  const payScript = pay.length ? ` ${pay[0]}` : '', payAll = [...new Set([...pay, ...(pay.length ? ['https://checkout.razorpay.com', 'https://api.razorpay.com'] : [])])].join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${opts.dev ? " 'unsafe-eval'" : ''}${payScript}`,       // Next.js inline bootstrap
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://*.supabase.co${pay.length ? ' https://*.razorpay.com' : ''}`,
    "font-src 'self' data:",
    `connect-src 'self' https://*.supabase.co${pay.length ? ` ${payAll} https://*.razorpay.com` : ''}${opts.dev ? ' ws: wss:' : ''}`,
    ...(pay.length ? [`frame-src ${payAll}`] : []),
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');
}

export const STATIC_SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];
