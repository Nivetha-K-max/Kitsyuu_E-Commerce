'use client';
/* Ctrl/⌘ K command palette: jump to any page the person can open, run a quick action, search everything, or switch the
   theme. Everything it offers was already filtered by permission on the server. */
import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon } from './icons';
import { GO_KEYS } from './shortcuts';
import { setTheme, THEME_OPTIONS } from './ThemeToggle';

export interface QuickAction { href: string; label: string; icon: string }

export default function CommandPalette({ open, onOpenChange, items, actions, onToggleSidebar }: {
  open: boolean; onOpenChange: (o: boolean) => void;
  items: { href: string; label: string; group: string; icon: string }[]; actions: QuickAction[]; onToggleSidebar: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const run = (fn: () => void) => { onOpenChange(false); setQuery(''); fn(); };
  const go = (href: string) => run(() => router.push(href));
  const term = query.trim();
  return (
    <Dialog.Root open={open} onOpenChange={o => { onOpenChange(o); if (!o) setQuery(''); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="cmdk" aria-describedby={undefined} data-command-palette>
          <Dialog.Title className="sr-only">Command menu</Dialog.Title>
          <Command label="Command menu" loop>
            <span className="cmdk-search-icon"><Icon name="search" size={18} /></span>
            <Command.Input value={query} onValueChange={setQuery} placeholder="Search pages and actions, or type to search everything…" name="q" />
            <Command.List>
              <Command.Empty>No pages or actions match. Press Enter to search everything.</Command.Empty>
              {term && (
                <Command.Group heading="Search">
                  <Command.Item value={`search-everything ${term}`} forceMount onSelect={() => go(`/search?q=${encodeURIComponent(term)}`)} data-command-search>
                    <Icon name="search" />Search everything for “{term}”<span className="cmdk-hint"><Icon name="enter" size={14} /></span>
                  </Command.Item>
                </Command.Group>
              )}
              {actions.length > 0 && (
                <Command.Group heading="Actions">
                  {actions.map(a => (
                    <Command.Item key={a.href} value={a.label} onSelect={() => go(a.href)}><Icon name={a.icon} />{a.label}</Command.Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Go to">
                {items.map(i => (
                  <Command.Item key={i.href} value={`${i.label} ${i.group}`} onSelect={() => go(i.href)}>
                    <Icon name={i.icon} />{i.label}
                    <span className="cmdk-hint">{GO_KEYS[i.href] ? <><kbd>G</kbd><kbd>{GO_KEYS[i.href]}</kbd></> : i.group}</span>
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="Preferences">
                {THEME_OPTIONS.map(o => (
                  <Command.Item key={o.value} value={`theme ${o.label}`} onSelect={() => run(() => setTheme(o.value))}><Icon name={o.icon} />Theme: {o.label}</Command.Item>
                ))}
                <Command.Item value="toggle sidebar collapse" onSelect={() => run(onToggleSidebar)}><Icon name="panel-close" />Collapse or expand the sidebar<span className="cmdk-hint"><kbd>[</kbd></span></Command.Item>
              </Command.Group>
            </Command.List>
            <div className="cmdk-foot" aria-hidden="true">
              <span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>Esc</kbd> close</span>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
