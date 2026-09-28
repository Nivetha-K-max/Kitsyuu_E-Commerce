import type { NextConfig } from 'next';
import { STATIC_SECURITY_HEADERS, storefrontCsp } from './lib/csp';

/* M9: security headers (see lib/csp.ts). Checkout pages get their Content-Security-Policy from proxy.ts at request time,
   because it names the payment provider's origins from the deployment's configuration. */
const dev = process.env.NODE_ENV !== 'production';
const securityHeaders = [
  ...STATIC_SECURITY_HEADERS,
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.razorpay.com" "https://api.razorpay.com")' },
];

/* `/` is the KITSYUU homepage: the brand landing page, then the store (app/page.tsx).
   Old static-store URLs (dist/store/*.html) keep working. Query strings such as ?category= and ?sort= pass through. */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // M12: review photos (up to 3 × 5 MB, checked again on the server) travel in the server-action body; the default is 1 MB.
  experimental: { serverActions: { bodySizeLimit: '16mb' } },
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
      { source: '/((?!checkout(?:/|$)).*)', headers: [{ key: 'Content-Security-Policy', value: storefrontCsp({ dev }) }] },
      { source: '/assets/upscaled-1440/:frame*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] }
    ];
  }
};
export default nextConfig;
