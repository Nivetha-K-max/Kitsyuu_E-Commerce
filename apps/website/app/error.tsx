'use client';
/* Shown when a page cannot load the catalogue (e.g. Supabase unreachable). There is deliberately no products.json fallback. */
export default function CatalogueError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="st-wrap">
      <section className="st-empty">
        <p className="eyebrow"><span></span>CATALOGUE UNAVAILABLE</p>
        <h1>Products could not load.</h1>
        <p>The store could not reach its product database. Check the connection and try again.{error.digest ? ` (Reference ${error.digest})` : ''}</p>
        <button className="button" type="button" onClick={reset}>Try again</button>
      </section>
    </div>
  );
}
