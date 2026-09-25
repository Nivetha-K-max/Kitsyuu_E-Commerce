import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';
import { getCatalogue, toClientCatalogue } from '@/lib/catalogue';
import StoreProvider from '@/components/StoreProvider';
import AuthProvider from '@/components/AuthProvider';
import Header from '@/components/Header';
import Footer from '@/components/Footer';

export const metadata: Metadata = {
  title: { default: 'KITSYUU Store: Japanese streetwear (prototype)', template: '%s | KITSYUU Store' },
  description: 'Prototype KITSYUU store: Japanese streetwear brought to India. Tops, bottoms and outerwear from the prototype catalogue.',
  icons: { icon: { url: '/assets/kitsyuu-icon.svg', type: 'image/svg+xml' } }
};
export const viewport: Viewport = { themeColor: '#101011' };
/* Catalogue pages are regenerated at most every 60 s, so price/stock changes in Supabase appear without a rebuild. */
export const revalidate = 60;

/* The KITSYUU stylesheets are served as-is from public/ in the same order as the static store:
   fonts.css → styles.css (shared tokens) → store.css (st- classes). */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const catalogue = toClientCatalogue(await getCatalogue());
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
        <StoreProvider catalogue={catalogue}>
          <a className="skip" href="#main">Skip to content</a>
          <p className="st-notice"><b>Prototype store.</b> Products, sizes and prices are estimates. Nothing can be purchased yet.</p>
          <Suspense fallback={<header className="st-header" />}><Header /></Suspense>
          <main id="main" tabIndex={-1}>{children}</main>
          <Footer catalogue={catalogue} />
        </StoreProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
