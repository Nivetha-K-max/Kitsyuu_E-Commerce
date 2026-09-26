import type { NextConfig } from 'next';

/* Routes (M5): `/` is the original static KITSYUU landing page (public/landing.html, copied from ../../dist at build time
   by scripts/copy-landing.mjs); the Next.js store home is /store; every other store URL (/shop, /product/…, /cart, …)
   is unchanged. Old static-store URLs (dist/store/*.html) keep working. Query strings such as ?category= and ?sort= pass through. */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    // beforeFiles: `/` shows the landing page (the address bar stays `/`, so its relative asset URLs resolve from the root).
    return { beforeFiles: [{ source: '/', destination: '/landing.html' }], afterFiles: [], fallback: [] };
  },
  async redirects() {
    return [
      { source: '/store/index.html', destination: '/store', permanent: false },
      { source: '/store/shop.html', destination: '/shop', permanent: false },
      { source: '/store/product.html', has: [{ type: 'query', key: 'p', value: '(?<slug>.+)' }], destination: '/product/:slug', permanent: false },
      { source: '/store/:page(search|cart|wishlist|checkout|confirmation).html', destination: '/:page', permanent: false }
    ];
  },
  async headers() {
    // The landing's frame sequence: 241 large, never-edited files. A changed sequence must use a new folder name.
    return [{ source: '/assets/upscaled-1440/:frame*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] }];
  }
};
export default nextConfig;
