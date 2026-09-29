import ThemeToggle from '@/components/ThemeToggle';

/* Signed-out pages: a single centred panel. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="auth" tabIndex={-1}>
      <div className="auth-tools"><ThemeToggle /></div>
      <section className="auth-panel">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <span className="brand-mark"><img src="/assets/kitsyuu-icon.svg" alt="" width={12} height={17} /></span>
          <span className="brand-text"><b>KITSYUU</b><small>Admin</small></span>
        </div>
        {children}
      </section>
    </main>
  );
}
