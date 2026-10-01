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
/* Performance (2026-10-01): one version per build (the deployment's commit on Vercel), added to the stylesheet URLs in
   app/layout.tsx so they can be cached for a year without a new deployment ever getting an old stylesheet. */
const ASSET_VERSION = (process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 12) || Date.now().toString(36);
const YEAR = 'public, max-age=31536000, immutable';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_ASSET_VERSION: ASSET_VERSION },
  poweredByHeader: false,
  // M12: review photos (up to 3 × 5 MB, checked again on the server) travel in the server-action body; the default is 1 MB.
  experimental: { serverActions: { bodySizeLimit: '16mb' } },
  async redirects() {
    return [
      // Browsers ask for /favicon.ico on their own (e.g. for non-HTML responses): answer with the KITSYUU icon, not a 404.
      { source: '/favicon.ico', destination: '/assets/kitsyuu-icon.svg', permanent: true },
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
      // Brand photographs (hero, editorial, posters): a day, refreshed in the background, so a replaced photo shows the next day at the latest.
      { source: '/assets/:file(.*\\.(?:webp|avif|jpg|png|svg))', headers: [{ key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' }] },
      // (More specific rules below override this one: Next applies the last matching value.)
      { source: '/assets/upscaled-1440/:frame*', headers: [{ key: 'Cache-Control', value: YEAR }] },
      // Performance (2026-10-01): the homepage film's resized frames and posters (a new set gets a new folder name).
      { source: '/assets/film-v1/:file*', headers: [{ key: 'Cache-Control', value: YEAR }] },
      // Stylesheets: always requested with ?v=<build> (app/layout.tsx).
      { source: '/:css(fonts|styles|store|account).css', headers: [{ key: 'Cache-Control', value: YEAR }] },
      // Typefaces never change in place; a month, then revalidated in the background.
      { source: '/assets/fonts/:file*', headers: [{ key: 'Cache-Control', value: 'public, max-age=2592000, stale-while-revalidate=31536000' }] },
    ];
  }
};
export default nextConfig;
