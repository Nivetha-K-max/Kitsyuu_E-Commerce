import type { NextConfig } from 'next';

/* Old static-store URLs (dist/store/*.html) keep working. Query strings such as ?category= and ?sort= pass through. */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async redirects() {
    return [
      { source: '/store', destination: '/', permanent: false },
      { source: '/store/index.html', destination: '/', permanent: false },
      { source: '/store/shop.html', destination: '/shop', permanent: false },
      { source: '/store/product.html', has: [{ type: 'query', key: 'p', value: '(?<slug>.+)' }], destination: '/product/:slug', permanent: false },
      { source: '/store/:page(search|cart|wishlist|checkout|confirmation).html', destination: '/:page', permanent: false }
    ];
  }
};
export default nextConfig;
