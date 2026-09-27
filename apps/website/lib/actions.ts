import 'server-only';
/* Shared server-action plumbing: FormData → validated input → service call. Domain errors (written for customers) become
   form messages; anything unexpected is logged on the server with a reference and shown only as a generic message, so
   database errors, stack traces and internal details never reach the browser. */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { DomainError, fieldErrors, type ActionState } from '@kitsyuu/contracts';

export function formObject(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(form.keys())) {
    const v = form.get(key);
    out[key] = typeof v === 'string' ? v : '';
  }
  return out;
}

export const GENERIC_ERROR = 'Something went wrong. Please try again.';

export async function handle<S extends z.ZodType>(
  schema: S, form: FormData, run: (input: z.output<S>) => Promise<ActionState | void>,
): Promise<ActionState> {
  const parsed = schema.safeParse(formObject(form));
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrors(parsed.error), message: 'Check the highlighted fields.' };
  try {
    return (await run(parsed.data)) ?? { ok: true, message: 'Saved.' };
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message };
    if (e && typeof e === 'object' && 'digest' in e) throw e;         // redirect()/notFound() work by throwing
    const ref = randomUUID().slice(0, 8);
    console.error(`[website action] ref=${ref}`, e);
    return { ok: false, message: `${GENERIC_ERROR} (Reference ${ref})` };
  }
}
