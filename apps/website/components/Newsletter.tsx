'use client';
import { useRef, useState } from 'react';

/* Prototype form: validates the address but sends and stores nothing. */
export default function Newsletter() {
  const input = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState(''), [bad, setBad] = useState(false);
  return (
    <form className="st-news-form" noValidate onSubmit={e => {
      e.preventDefault();
      if (!input.current!.checkValidity()) { setBad(true); setMsg('Enter a valid email address.'); input.current!.focus(); return; }
      setBad(false); setMsg('Thanks. This is a prototype, so the address was not sent or stored.');
    }}>
      <label htmlFor="st-news-email">Email address</label>
      <div className="st-news-row">
        <input ref={input} id="st-news-email" type="email" name="email" autoComplete="email" placeholder="you@example.com" required aria-describedby="st-news-note" aria-invalid={bad || undefined} />
        <button className="button" type="submit">Sign up</button>
      </div>
      <p className="st-note" id="st-news-note">Prototype form. Email addresses are not sent, collected or stored.</p>
      <p className="st-news-msg" role="status" aria-live="polite">{msg}</p>
    </form>
  );
}
