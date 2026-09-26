import type { NextConfig } from 'next';

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
    return [{ source: '/assets/upscaled-1440/:frame*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] }];
  }
};
export default nextConfig;
