'use client';
/* The signed-in person's menu: account, theme and sign out. Shown at the foot of the sidebar and as the avatar in the
   top bar. Sign out posts the same server action as before (through a form outside the menu, so closing the menu can
   never cancel the submission). */
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import Link from 'next/link';
import { useRef } from 'react';
import { Icon } from './icons';
import { ThemeItems, useThemePref } from './ThemeToggle';

export function initialsOf(user: { name: string; email: string }) {
  return (user.name || user.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(s => s[0]!.toUpperCase()).join('');
}

export default function UserMenu({ user, logout, variant, onShortcuts }: {
  user: { name: string; email: string }; logout: () => Promise<void>; variant: 'side' | 'avatar'; onShortcuts: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [pref, setPref] = useThemePref();
  const initials = initialsOf(user);
  return (
    <>
      <form ref={form} action={logout} hidden />
      <Dropdown.Root>
        {variant === 'side' ? (
          <Dropdown.Trigger className="user-trigger" data-user-menu aria-label="Account menu">
            <span className="avatar" aria-hidden="true">{initials}</span>
            <span className="user-trigger-text"><b>{user.name || user.email}</b><small>{user.email}</small></span>
            <Icon name="updown" size={14} />
          </Dropdown.Trigger>
        ) : (
          <Dropdown.Trigger className="avatar-btn" data-user-menu="avatar" aria-label="Account menu" title={user.email}>
            <span className="avatar" aria-hidden="true">{initials}</span>
          </Dropdown.Trigger>
        )}
        <Dropdown.Portal>
          <Dropdown.Content className="menu" side={variant === 'side' ? 'top' : 'bottom'} align={variant === 'side' ? 'start' : 'end'} sideOffset={6} style={{ minWidth: 232 }}>
            <div className="menu-head"><b>{user.name || 'Signed in'}</b><small>{user.email}</small></div>
            <Dropdown.Separator className="menu-sep" />
            <Dropdown.Item asChild className="menu-item"><Link href="/account" data-account><Icon name="account" />My account</Link></Dropdown.Item>
            <Dropdown.Item className="menu-item" onSelect={onShortcuts}><Icon name="keyboard" />Command menu<kbd>Ctrl K</kbd></Dropdown.Item>
            <Dropdown.Sub>
              <Dropdown.SubTrigger className="menu-item"><Icon name="theme" />Theme<Icon name="chevron-right" size={14} /></Dropdown.SubTrigger>
              <Dropdown.Portal>
                <Dropdown.SubContent className="menu" sideOffset={6} style={{ minWidth: 160 }}>
                  <ThemeItems pref={pref} onPick={setPref} />
                </Dropdown.SubContent>
              </Dropdown.Portal>
            </Dropdown.Sub>
            <Dropdown.Separator className="menu-sep" />
            <Dropdown.Item className="menu-item" data-logout onSelect={e => { e.preventDefault(); form.current?.requestSubmit(); }}>
              <Icon name="logout" />Sign out
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
    </>
  );
}
