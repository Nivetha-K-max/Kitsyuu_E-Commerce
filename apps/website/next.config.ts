import type { NextConfig } from 'next';

/* M9: security headers for every storefront page. The browser may only load from this origin, product images from
   Supabase Storage, and Razorpay Checkout (script + its frames/API) for the payment step. Development adds what the
   Next.js dev server needs (eval for React debugging, websocket for hot reload); production never gets them. */
const dev = process.env.NODE_ENV !== 'production';
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''} https://checkout.razorpay.com`,   // Next.js inline bootstrap
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.supabase.co https://*.razorpay.com",
  "font-src 'self' data:",
  `connect-src 'self' https://*.supabase.co https://*.razorpay.com${dev ? ' ws: wss:' : ''}`,
  'frame-src https://api.razorpay.com https://checkout.razorpay.com',
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');
const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.razorpay.com" "https://api.razorpay.com")' },
];

/* `/` is the KITSYUU homepage: the brand landing page, then the store (app/page.tsx).
   Old static-store URLs (dist/store/*.html) keep working. Query strings such as ?category= and ?sort= pass through. */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async redirects() {
    return [
      { source: '/store', destination: '/#store', permanent: false },
      { source: '/store/index.html', destination: '/#store', permanent: false },
      { source: '/store/shop.html', destination: '/shop', permanent: false },
      { source: '/store/product.html', has: [{ type: 'query', key: 'p', value: '(?<slug>.+)' }], destination: '/product/:slug', permanent: false },
      { source: '/store/:page(search|cart|wishlist|checkout|confirmation).html', destination: '/:page', permanent: false }
    ];
  },
  async headers() {
    // The homepage's landing frame sequence (copied from dist/ at build time): 241 large, never-edited files.
    // A changed sequence must use a new folder name. Nothing else gets a long-lived cache.
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/assets/upscaled-1440/:frame*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] }
    ];
  }
};
export default nextConfig;
