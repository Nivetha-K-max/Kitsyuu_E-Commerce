'use client';
/* Last-resort error page when the root layout itself cannot load the catalogue. Uses the same KITSYUU styles. */
const V = process.env.NEXT_PUBLIC_ASSET_VERSION ?? 'dev';
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" className="st">
      <head>
        {/* Same versioned stylesheet URLs as app/layout.tsx (they are cached for a year). */}
        <link rel="stylesheet" href={`/fonts.css?v=${V}`} /><link rel="stylesheet" href={`/styles.css?v=${V}`} /><link rel="stylesheet" href={`/store.css?v=${V}`} />
        <title>Catalogue unavailable | KITSYUU Store</title>
      </head>
      <body className="store">
        <main id="main" className="st-wrap">
          <section className="st-empty">
            <p className="eyebrow"><span></span>CATALOGUE UNAVAILABLE</p>
            <h1>Products could not load.</h1>
            <p>The store could not reach its product database. Check the connection and try again.{error.digest ? ` (Reference ${error.digest})` : ''}</p>
            <button className="button" type="button" onClick={reset}>Try again</button>
          </section>
        </main>
      </body>
    </html>
  );
}
