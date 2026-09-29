'use client';
/* Filter bar for list pages: the same GET form as before (fields, names and URL are unchanged, so links and bookmarks
   keep working), but it applies as you go — choices at once, typing after a short pause — without a full page load.
   The list below dims while the new results load. */
import { usePathname, useRouter } from 'next/navigation';
import { useRef, useTransition, type FormEvent, type FormHTMLAttributes, type ReactNode } from 'react';

export default function FilterForm({ children, ...rest }: { children: ReactNode } & Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit' | 'onChange'>) {
  const router = useRouter();
  const path = usePathname();
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apply = (form: HTMLFormElement) => {
    const sp = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (typeof v === 'string' && v.trim() !== '') sp.append(k, v.trim());
    start(() => router.replace(sp.size ? `${path}?${sp}` : path, { scroll: false }));
  };
  const onChange = (e: FormEvent<HTMLFormElement>) => {
    const form = e.currentTarget;
    const el = e.target as HTMLInputElement;
    if (timer.current) clearTimeout(timer.current);
    const typing = el.tagName === 'INPUT' && /^(text|search|email|tel|)$/.test(el.type);
    if (typing) timer.current = setTimeout(() => apply(form), 350); else apply(form);
  };
  return (
    <form {...rest} method="get" className={`filter-bar${rest.className ? ` ${rest.className}` : ''}`} data-pending={pending || undefined}
      onChange={onChange} onSubmit={e => { e.preventDefault(); if (timer.current) clearTimeout(timer.current); apply(e.currentTarget); }}>
      {children}
    </form>
  );
}
