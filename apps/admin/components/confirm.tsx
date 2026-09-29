'use client';
/* Confirmation dialog (replaces window.confirm): useConfirm() returns ask(question) → Promise<boolean>.
   Focus is trapped in the dialog, Escape or Cancel answers "no", and focus returns to what opened it.
   Outside the signed-in shell (no provider) it falls back to the browser's own confirm. */
import * as Dialog from '@radix-ui/react-dialog';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

export interface ConfirmOptions { title: string; description?: string; confirmLabel?: string; tone?: 'danger' | 'default' }
type Ask = (q: string | ConfirmOptions) => Promise<boolean>;
const Ctx = createContext<Ask | null>(null);

export function useConfirm(): Ask {
  const ask = useContext(Ctx);
  return ask ?? (async q => window.confirm(typeof q === 'string' ? q : q.title));
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const ask = useCallback<Ask>(q => new Promise<boolean>(resolve => {
    resolver.current?.(false);
    resolver.current = resolve;
    setOpts(typeof q === 'string' ? { title: q } : q);
  }), []);
  const answer = (v: boolean) => { resolver.current?.(v); resolver.current = null; setOpts(null); };
  return (
    <Ctx.Provider value={ask}>
      {children}
      <Dialog.Root open={!!opts} onOpenChange={o => { if (!o) answer(false); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog" data-confirm-dialog aria-describedby={opts?.description ? 'confirm-desc' : undefined}>
            <Dialog.Title data-confirm-text>{opts?.title}</Dialog.Title>
            {opts?.description && <Dialog.Description id="confirm-desc">{opts.description}</Dialog.Description>}
            <div className="dialog-actions">
              <button type="button" className="btn ghost" onClick={() => answer(false)} data-confirm-cancel>Cancel</button>
              <button type="button" className={`btn${opts?.tone === 'danger' ? ' solid-danger' : ''}`} onClick={() => answer(true)} data-confirm-accept autoFocus>
                {opts?.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Ctx.Provider>
  );
}
