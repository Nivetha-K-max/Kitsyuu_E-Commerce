/* robots.txt (2026-10-01): the catalogue is open to search engines; personal and transactional pages are not. */
import type { MetadataRoute } from 'next';
import { absolute } from '@/lib/seo';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/account', '/cart', '/checkout', '/wishlist', '/login', '/signup', '/forgot-password', '/reset-password', '/verify-email', '/auth', '/api', '/confirmation'] },
    sitemap: absolute('/sitemap.xml'),
  };
}
