import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';
import { getCatalogue, toClientCatalogue } from '@/lib/catalogue';
import { getAnnouncement, getBrandCopy, getCartRefreshMinutes, getReturnsPolicy } from '@/lib/content';
import StoreProvider from '@/components/StoreProvider';
import AuthProvider from '@/components/AuthProvider';
import Header from '@/components/Header';
import Footer from '@/components/Footer';

/* The site title and description are part of the editable brand wording (client change request); the defaults are the
   original text. */
export async function generateMetadata(): Promise<Metadata> {
  const copy = await getBrandCopy();
  return {
    title: { default: copy.metaTitle, template: '%s | KITSYUU Store' },
    description: copy.metaDescription,
    icons: { icon: { url: '/assets/kitsyuu-icon.svg', type: 'image/svg+xml' } },
  };
}
export const viewport: Viewport = { themeColor: '#101011' };
/* Catalogue pages are regenerated at most every 60 s, so price/stock changes in Supabase appear without a rebuild. */
export const revalidate = 60;

/* The KITSYUU stylesheets are served as-is from public/ in the same order as the static store:
   fonts.css → styles.css (shared tokens) → store.css (st- classes). */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [catalogue, announcement, policy, copy, refreshMinutes] = await Promise.all([getCatalogue().then(toClientCatalogue), getAnnouncement(), getReturnsPolicy(), getBrandCopy(), getCartRefreshMinutes()]);
  return (
    <html lang="en" className="st">
      <head>
        <link rel="stylesheet" href="/fonts.css" />
        <link rel="stylesheet" href="/styles.css" />
        <link rel="stylesheet" href="/store.css" />
        <link rel="stylesheet" href="/account.css" />
      </head>
      <body className="store">
        <AuthProvider>
        <StoreProvider catalogue={catalogue} refreshMinutes={refreshMinutes}>
          <a className="skip" href="#main">Skip to content</a>
          {announcement && (
            <p className="st-announce" data-announcement>{announcement.href
              ? <a href={announcement.href}>{announcement.text} <span aria-hidden="true">→</span></a> : announcement.text}</p>
          )}
          <Suspense fallback={<header className="st-header" />}><Header /></Suspense>
          <main id="main" tabIndex={-1}>{children}</main>
          <Footer catalogue={catalogue} policy={policy} tagline={copy.footerTagline} />
        </StoreProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
