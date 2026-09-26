'use client';
/* Form plumbing for server actions: the action returns ActionState; errors are shown next to their fields.
   Submission goes through onSubmit + startTransition instead of <form action>, because React 19 resets every field
   after a form action completes, which would wipe what the person typed whenever validation fails. The server
   action, its validation and its permission checks are the same either way. */
import { createContext, startTransition, useActionState, useContext, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ActionState } from '@kitsyuu/contracts';
import { Icon } from './icons';

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;
const StateCtx = createContext<ActionState>({});

export function ActionForm({ action, children, submitLabel, pendingLabel, className = 'form', variant, confirmText, confirm, id, resetOnSuccess, label, hideSubmit }: {
  action: Action; children?: ReactNode; submitLabel: string; pendingLabel?: string; className?: string;
  variant?: 'ghost' | 'danger'; confirmText?: string; id?: string; label?: string;
  /** Builds a confirmation question from the form's current values; return null to skip asking. */
  confirm?: (data: FormData) => string | null;
  /** Clear the fields after a successful submission (e.g. stock adjustments, so a second click cannot repeat it). */
  resetOnSuccess?: boolean;
  /** Render without a submit button (e.g. nothing more can be done) while keeping the last result message on screen. */
  hideSubmit?: boolean;
}) {
  const [state, dispatch, pending] = useActionState(action, {});
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { if (resetOnSuccess && state.ok) formRef.current?.reset(); }, [state, resetOnSuccess]);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || hideSubmit) return;
    const data = new FormData(e.currentTarget);
    const question = confirm ? confirm(data) : confirmText ?? null;
    if (question && !window.confirm(question)) return;
    startTransition(() => dispatch(data));
  }
  return (
    <form ref={formRef} onSubmit={onSubmit} className={className} id={id} noValidate aria-busy={pending || undefined} aria-label={label}>
      <StateCtx.Provider value={state}>
        {children}
        {state.message && <p className={`msg ${state.ok ? 'ok' : 'error'}`} role={state.ok ? 'status' : 'alert'} data-form-message>{state.message}</p>}
        {!hideSubmit && <div className="actions">
          <button type="submit" className={`btn${variant ? ' ' + variant : ''}`} disabled={pending} aria-disabled={pending}>
            {pending ? (pendingLabel ?? 'Working…') : submitLabel}
          </button>
        </div>}
      </StateCtx.Provider>
    </form>
  );
}

export function Field({ name, label, type = 'text', defaultValue, autoComplete, hint, required, readOnly }: {
  name: string; label: string; type?: string; defaultValue?: string; autoComplete?: string; hint?: string; required?: boolean; readOnly?: boolean;
}) {
  const id = useId();
  const error = useContext(StateCtx).fieldErrors?.[name];
  return (
    <div className="field">
      <label htmlFor={id}>{label}{required && <span className="req" aria-hidden="true">*</span>}</label>
      <input id={id} name={name} type={type} className="input" defaultValue={defaultValue} autoComplete={autoComplete}
        required={required} readOnly={readOnly} aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${id}-d` : undefined} />
      {(error || hint) && <span id={`${id}-d`} className={error ? 'field-error' : 'note'}>{error ?? hint}</span>}
    </div>
  );
}

export function Select({ name, label, options, defaultValue, hint, required }: {
  name: string; label: string; options: { value: string; label: string; group?: string }[]; defaultValue?: string; hint?: string; required?: boolean;
}) {
  const id = useId();
  const error = useContext(StateCtx).fieldErrors?.[name];
  return (
    <div className="field">
      <label htmlFor={id}>{label}{required && <span className="req" aria-hidden="true">*</span>}</label>
      <select id={id} name={name} className="input" defaultValue={defaultValue} required={required}
        aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${id}-d` : undefined}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {(error || hint) && <span id={`${id}-d`} className={error ? 'field-error' : 'note'}>{error ?? hint}</span>}
    </div>
  );
}

export function TextArea({ name, label, defaultValue, hint, rows = 4, required }: { name: string; label: string; defaultValue?: string; hint?: string; rows?: number; required?: boolean }) {
  const id = useId();
  const error = useContext(StateCtx).fieldErrors?.[name];
  return (
    <div className="field">
      <label htmlFor={id}>{label}{required && <span className="req" aria-hidden="true">*</span>}</label>
      <textarea id={id} name={name} className="input" rows={rows} defaultValue={defaultValue} required={required}
        aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${id}-d` : undefined} />
      {(error || hint) && <span id={`${id}-d`} className={error ? 'field-error' : 'note'}>{error ?? hint}</span>}
    </div>
  );
}

export function Checkbox({ name, label, defaultChecked, hint }: { name: string; label: string; defaultChecked?: boolean; hint?: string }) {
  return (
    <label className="check">
      <input type="checkbox" name={name} value="on" defaultChecked={defaultChecked} />
      <span>{label}{hint && <small>{hint}</small>}</span>
    </label>
  );
}

export function FileField({ name, label, accept, hint }: { name: string; label: string; accept: string; hint?: string }) {
  const id = useId();
  const error = useContext(StateCtx).fieldErrors?.[name];
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={name} type="file" accept={accept} className="input"
        aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${id}-d` : undefined} />
      {(error || hint) && <span id={`${id}-d`} className={error ? 'field-error' : 'note'}>{error ?? hint}</span>}
    </div>
  );
}

/** A file input presented as a drop zone. The real <input type=file> covers the zone (transparent), so clicking,
    keyboard use and dropping a file all go through the browser's own file input; nothing about the upload changes. */
export function DropzoneField({ name, title, accept, formats, hint }: { name: string; title: string; accept: string; formats: string; hint?: string }) {
  const id = useId();
  const error = useContext(StateCtx).fieldErrors?.[name];
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const form = inputRef.current?.form;
    const clear = () => setFile(null);
    form?.addEventListener('reset', clear);
    return () => form?.removeEventListener('reset', clear);
  }, []);
  const pick = (el: HTMLInputElement) => { const f = el.files?.[0]; setFile(f ? { name: f.name, size: f.size } : null); setOver(false); };
  return (
    <div className="field">
      <div className="dropzone" data-over={over || undefined} data-filled={file ? true : undefined} data-invalid={error ? true : undefined}>
        <input ref={inputRef} id={id} name={name} type="file" accept={accept} className="dropzone-input"
          onChange={e => pick(e.currentTarget)} onDragEnter={() => setOver(true)} onDragLeave={() => setOver(false)} onDrop={() => setOver(false)}
          aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${id}-d ${id}-e` : `${id}-d`} />
        <span className="dropzone-icon" aria-hidden="true"><Icon name="upload" size={20} /></span>
        <label htmlFor={id} className="dropzone-title">{title}</label>
        <p className="dropzone-line" aria-hidden="true">Drag and drop an image here, or <u>choose a file</u></p>
        <p className="dropzone-formats" id={`${id}-d`}>
          {file ? <>Selected: {file.name} · {(file.size / 1048576).toFixed(file.size < 1048576 ? 2 : 1)} MB</> : formats}
        </p>
      </div>
      {(error || hint) && <span id={`${id}-e`} className={error ? 'field-error' : 'note'} role={error ? 'alert' : undefined}>{error ?? hint}</span>}
    </div>
  );
}

export function FieldError({ name }: { name: string }) {
  const error = useContext(StateCtx).fieldErrors?.[name];
  return error ? <span className="field-error" role="alert">{error}</span> : null;
}

export function Hidden({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />;
}
