import { LANDING_HTML } from '@/lib/landing.generated';
import LandingScript from './LandingScript';

/* The original KITSYUU landing page (dist/landing.html), shown first on the homepage. Its markup, styles (styles.css)
   and behaviour (app.js) are the originals: the markup is generated at build time by scripts/copy-landing.mjs and the
   original script runs against it unchanged. It is kept as authored HTML (not React) so nothing about it changes. */
export default function Landing() {
  return (
    <>
      {/* The browser re-serialises authored HTML (e.g. `hidden` → `hidden=""`), so React's development check would always
          report a difference here; the server markup is kept as-is either way. */}
      <div className="kitsyuu-landing" data-landing suppressHydrationWarning dangerouslySetInnerHTML={{ __html: LANDING_HTML }} />
      <LandingScript />
    </>
  );
}
