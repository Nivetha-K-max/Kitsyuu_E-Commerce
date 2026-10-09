import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: { default: 'KITSYUU Admin', template: '%s | KITSYUU Admin' },
  robots: { index: false, follow: false, nocache: true },
  icons: { icon: { url: '/assets/kitsyuu-icon.svg', type: 'image/svg+xml' } },
};
export const viewport: Viewport = {
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f6f4ef' }, { media: '(prefers-color-scheme: dark)', color: '#101011' }],
};

/* Applies the stored theme before the first paint (no flash). Default is light; "system" follows the OS setting.
   Must stay in sync with components/ThemeToggle.tsx (same storage key and values). Also restores a collapsed sidebar
   (components/shortcuts.ts, same key). */
const THEME_SCRIPT = `(function(){var d=document.documentElement,p='light';try{p=localStorage.getItem('kitsyuu-admin-theme')||'light'}catch(e){}
if(p!=='dark'&&p!=='system')p='light';var dark=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
d.dataset.theme=dark?'dark':'light';d.dataset.themePref=p;
try{if(localStorage.getItem('kitsyuu-admin-sidebar')==='collapsed')d.dataset.sidebar='collapsed'}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* The brand faces (the store's own files): the text face and the title face are needed for the first paint. */}
        <link rel="preload" href="/assets/fonts/dm-sans-400.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/assets/fonts/barlow-condensed-600.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="stylesheet" href="/admin.css" />
      </head>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
