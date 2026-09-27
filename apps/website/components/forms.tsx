'use client';
/* Form plumbing for the customer account (M6): a server action returns ActionState; errors are shown next to their fields,
   in the store's existing form styles. Submission goes through onSubmit + startTransition instead of <form action>,
   because React 19 resets every field after a form action completes, which would wipe what the customer typed whenever
   validation fails. The server action does all validation and authorization either way. */
import { createContext, startTransition, useActionState, useContext, useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import type { ActionState } from '@kitsyuu/contracts';

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;
const StateCtx = createContext<ActionState>({});

export function ActionForm({ action, children, submitLabel, pendingLabel, className = 'st-auth-form', buttonClass = 'button st-place', confirmText, resetOnSuccess, label, id, footer }: {
  action: Action; children?: ReactNode; submitLabel: string; pendingLabel?: string; className?: string; buttonClass?: string;
  /** Asks before submitting (e.g. deleting an address). */
  confirmText?: string;
  resetOnSuccess?: boolean; label?: string; id?: string;
  /** Rendered after the submit button (e.g. "Forgot your password?"). */
  footer?: ReactNode;
}) {
  const [state, dispatch, pending] = useActionState(action, {});
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { if (resetOnSuccess && state.ok) formRef.current?.reset(); }, [state, resetOnSuccess]);
  useEffect(() => {
    // Move focus to the first invalid field (or the message) so keyboard and screen-reader users hear what went wrong.
    if (state.ok || (!state.message && !state.fieldErrors)) return;
    const f = formRef.current;
    (f?.querySelector('[aria-invalid="true"]') as HTMLElement | null ?? f?.querySelector('[data-form-message]') as HTMLElement | null)?.focus();
  }, [state]);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    if (confirmText && !window.confirm(confirmText)) return;
    const data = new FormData(e.currentTarget);
    startTransition(() => dispatch(data));
  }
  return (
    <form ref={formRef} onSubmit={onSubmit} className={className} id={id} noValidate aria-busy={pending || undefined} aria-label={label}>
      <StateCtx.Provider value={state}>
        {state.message && <div className={state.ok ? 'st-form-ok' : 'st-form-alert'} role={state.ok ? 'status' : 'alert'} tabIndex={-1} data-form-message>{state.message}</div>}
        {children}
        <button type="submit" className={buttonClass} disabled={pending} aria-disabled={pending}>{pending ? (pendingLabel ?? 'Working…') : submitLabel}</button>
        {footer}
      </StateCtx.Provider>
    </form>
  );
}

function useFieldError(name: string) { return useContext(StateCtx).fieldErrors?.[name]; }

export function Field({ name, label, type = 'text', defaultValue, autoComplete, hint, required, inputMode, maxLength, wide }: {
  name: string; label: string; type?: string; defaultValue?: string | null; autoComplete?: string; hint?: string; required?: boolean;
  inputMode?: 'text' | 'numeric' | 'tel' | 'email'; maxLength?: number; wide?: boolean;
}) {
  const id = useId(), error = useFieldError(name);
  return (
    <div className={`st-field${wide ? ' st-field-wide' : ''}`}>
      <label htmlFor={id}>{label}{required && <span aria-hidden="true"> *</span>}</label>
      <input id={id} name={name} type={type} defaultValue={defaultValue ?? undefined} autoComplete={autoComplete} required={required}
        inputMode={inputMode} maxLength={maxLength} aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${id}-d` : undefined} />
      {(error || hint) && <p className={error ? 'st-field-error' : 'st-field-hint'} id={`${id}-d`}>{error ?? hint}</p>}
    </div>
  );
}

export function SelectField({ name, label, options, defaultValue, required, placeholder }: {
  name: string; label: string; options: readonly string[]; defaultValue?: string | null; required?: boolean; placeholder?: string;
}) {
  const id = useId(), error = useFieldError(name);
  return (
    <div className="st-field">
      <label htmlFor={id}>{label}{required && <span aria-hidden="true"> *</span>}</label>
      <select id={id} name={name} defaultValue={defaultValue ?? ''} required={required} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-d` : undefined}>
        <option value="">{placeholder ?? 'Choose…'}</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
      {error && <p className="st-field-error" id={`${id}-d`}>{error}</p>}
    </div>
  );
}

export function CheckField({ name, label, defaultChecked }: { name: string; label: string; defaultChecked?: boolean }) {
  return (
    <label className="st-check">
      <input type="checkbox" name={name} value="on" defaultChecked={defaultChecked} /> <span>{label}</span>
    </label>
  );
}

export function Hidden({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />;
}

/** A required choice from a short list (e.g. the delivery address), with its error shown under the group. */
export function RadioGroup({ name, legend, options, defaultValue }: {
  name: string; legend: string; options: { value: string; label: ReactNode }[]; defaultValue?: string;
}) {
  const id = useId(), error = useFieldError(name);
  return (
    <fieldset className="st-radio-group" aria-describedby={error ? `${id}-d` : undefined}>
      <legend>{legend}</legend>
      {options.map((o, i) => (
        <label className="st-radio" key={o.value}>
          <input type="radio" name={name} value={o.value} defaultChecked={o.value === defaultValue} aria-invalid={error && i === 0 ? true : undefined} />
          <span>{o.label}</span>
        </label>
      ))}
      {error && <p className="st-field-error" id={`${id}-d`}>{error}</p>}
    </fieldset>
  );
}
