import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: { default: 'KITSYUU Admin', template: '%s | KITSYUU Admin' },
  robots: { index: false, follow: false, nocache: true },
  icons: { icon: { url: '/assets/kitsyuu-icon.svg', type: 'image/svg+xml' } },
};
export const viewport: Viewport = {
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f6f7f9' }, { media: '(prefers-color-scheme: dark)', color: '#111318' }],
};

/* Applies the stored theme before the first paint (no flash). Default is light; "system" follows the OS setting.
   Must stay in sync with components/ThemeToggle.tsx (same storage key and values). */
const THEME_SCRIPT = `(function(){var d=document.documentElement,p='light';try{p=localStorage.getItem('kitsyuu-admin-theme')||'light'}catch(e){}
if(p!=='dark'&&p!=='system')p='light';var dark=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
d.dataset.theme=dark?'dark':'light';d.dataset.themePref=p})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link rel="stylesheet" href="/admin.css" />
      </head>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
