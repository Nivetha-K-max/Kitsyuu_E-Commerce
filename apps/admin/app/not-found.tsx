import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main" className="auth">
      <section className="auth-panel">
        <p className="eyebrow">404</p>
        <h1>Not found</h1>
        <p className="lead">This page does not exist.</p>
        <Link className="btn ghost" href="/dashboard">Go to the dashboard</Link>
      </section>
    </main>
  );
}
