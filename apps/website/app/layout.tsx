import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';
import { getCatalogue, toClientCatalogue } from '@/lib/catalogue';
import { getAnnouncement, getBrandCopy, getCartRefreshMinutes, getReturnsPolicy } from '@/lib/content';
import StoreProvider from '@/components/StoreProvider';
import AuthProvider from '@/components/AuthProvider';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import FirstOfferPopup from '@/components/FirstOfferPopup';
import HelpWidget from '@/components/HelpWidget';
import { DEFAULT_THEME, THEME_BOOT, THEME_COLOUR } from '@/lib/theme';
import { siteUrl } from '@/lib/seo';

/* The site title and description are part of the editable brand wording (client change request); the defaults are the
   original text. */
export async function generateMetadata(): Promise<Metadata> {
  const copy = await getBrandCopy();
  return {
    // Relative canonical / Open Graph URLs on every page resolve against the public origin (lib/seo.ts).
    metadataBase: new URL(siteUrl()),
    title: { default: copy.metaTitle, template: '%s | KITSYUU Store' },
    description: copy.metaDescription,
    openGraph: { type: 'website', siteName: 'KITSYUU Store', locale: 'en_IN', title: copy.metaTitle, description: copy.metaDescription },
    icons: { icon: { url: '/assets/kitsyuu-icon.svg', type: 'image/svg+xml' } },
  };
}
export const viewport: Viewport = { themeColor: THEME_COLOUR[DEFAULT_THEME] };
/* Catalogue pages are regenerated at most every 60 s, so price/stock changes in Supabase appear without a rebuild. */
export const revalidate = 60;

/* The KITSYUU stylesheets are served as-is from public/ in the same order as the static store:
   fonts.css → styles.css (shared tokens) → store.css (st- classes). Since 2026-10-14 store-fonts.css takes fonts.css's place. */
/* Performance (2026-10-01): the stylesheets carry the build's version, so browsers and the CDN keep them for a year
   (next.config.ts) and a new deployment's pages always ask for its own CSS. The two typefaces the first screen needs
   (DM Sans 400 for text, 700 for the KITSYUU wordmark) are preloaded; the product photos' host is connected to early. */
const V = process.env.NEXT_PUBLIC_ASSET_VERSION ?? 'dev';
const IMAGE_ORIGIN = (() => { try { return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').origin; } catch { return null; } })();

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [catalogue, announcement, policy, copy, refreshMinutes] = await Promise.all([getCatalogue().then(toClientCatalogue), getAnnouncement(), getReturnsPolicy(), getBrandCopy(), getCartRefreshMinutes()]);
  return (
    // suppressHydrationWarning: the boot script may set data-theme from the visitor's saved choice before React hydrates.
    <html lang="en" className="st" data-theme={DEFAULT_THEME} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        {IMAGE_ORIGIN && <link rel="preconnect" href={IMAGE_ORIGIN} />}
        {/* 2026-10-14: the Latin subsets of the typefaces (public/store-fonts.css; fonts.css stays as dist/ has it). */}
        <link rel="preload" href="/assets/fonts-latin-v1/font-3.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/assets/fonts-latin-v1/font-6.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="stylesheet" href={`/store-fonts.css?v=${V}`} />
        <link rel="stylesheet" href={`/styles.css?v=${V}`} />
        <link rel="stylesheet" href={`/store.css?v=${V}`} />
        <link rel="stylesheet" href={`/account.css?v=${V}`} />
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
          {/* The first-order offer (2026-10-12): asks the server only after the visitor scrolls into the store; renders nothing otherwise. */}
          <FirstOfferPopup />
          {/* The help window (2026-10-12): a Help button; it asks the server for nothing until it is opened. */}
          <HelpWidget />
        </StoreProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
