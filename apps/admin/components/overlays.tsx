'use client';
/* Shared overlays and action controls of the ERP frame (2026-10-07).

   · Drawer: a panel from the right for a short task that belongs to the page behind it (a new vendor, a banner, a
     tracking number). The page stays visible; Escape or the close button dismisses it; focus is trapped and returned.
   · MoreMenu: the "More" button of an entity header. Rare and destructive actions live here, so the header shows one
     primary next action and at most a couple of secondary ones.
   Confirmation is components/confirm.tsx (a question before an action); results are the form's own message or a toast. */
import * as Dialog from '@radix-ui/react-dialog';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from './icons';

export function Drawer({ trigger, triggerClass = 'btn', title, description, children, name, scope }: {
  /** The button that opens it. */
  trigger: ReactNode; triggerClass?: string;
  title: string; description?: string; children: ReactNode;
  /** data-drawer value, for tests and styling hooks. */
  name?: string;
  /** The module's colour scope (e.g. "ord"): the drawer is rendered outside the page, so it does not inherit it. */
  scope?: string;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger className={triggerClass} data-drawer-open={name}>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className={scope ? `drawer ${scope}` : 'drawer'} data-drawer={name} aria-describedby={description ? undefined : undefined}>
          <header className="drawer-head">
            <div><Dialog.Title>{title}</Dialog.Title>{description && <Dialog.Description>{description}</Dialog.Description>}</div>
            <Dialog.Close className="icon-btn" aria-label="Close"><Icon name="close" /></Dialog.Close>
          </header>
          <div className="drawer-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface MoreItem { label: string; href: string; icon?: string; danger?: boolean; external?: boolean }

/** "More": links to the less common things that can be done with this record (each opens the place that does it). */
export function MoreMenu({ items, label = 'More' }: { items: MoreItem[]; label?: string }) {
  if (!items.length) return null;
  return (
    <Dropdown.Root>
      <Dropdown.Trigger className="btn ghost sm" data-more-menu>{label}<Icon name="chevron-down" size={14} /></Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu" align="end" sideOffset={6}>
          {items.map(i => (
            <Dropdown.Item key={i.href + i.label} asChild className={`menu-item${i.danger ? ' danger' : ''}`}>
              {i.external ? <a href={i.href} target="_blank" rel="noreferrer">{i.icon && <Icon name={i.icon} />}{i.label}</a>
                : <Link href={i.href}>{i.icon && <Icon name={i.icon} />}{i.label}</Link>}
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
