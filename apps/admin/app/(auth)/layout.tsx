/* Signed-out pages: a single centred panel. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="auth" tabIndex={-1}>
      <section className="auth-panel">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/kitsyuu-icon.svg" alt="" width={22} height={30} />
          <div><b>KITSYUU</b><small>ADMIN / ERP</small></div>
        </div>
        {children}
      </section>
    </main>
  );
}
