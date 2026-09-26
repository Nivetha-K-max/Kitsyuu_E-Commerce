import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: { default: 'KITSYUU Admin', template: '%s | KITSYUU Admin' },
  robots: { index: false, follow: false, nocache: true },
  icons: { icon: { url: '/assets/kitsyuu-icon.svg', type: 'image/svg+xml' } },
};
export const viewport: Viewport = { themeColor: '#101011' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href="/fonts.css" />
        <link rel="stylesheet" href="/admin.css" />
      </head>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
