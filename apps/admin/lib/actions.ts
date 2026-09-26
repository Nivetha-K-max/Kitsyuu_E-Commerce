import 'server-only';
/* Shared server-action plumbing: FormData → validated input → service call, with domain errors turned into form
   messages. Unexpected errors are logged on the server and shown only as a generic message. */
import type { z } from 'zod';
import { DomainError, fieldErrors, type ActionState } from '@kitsyuu/contracts';

export function formObject(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(form.keys())) {
    const all = form.getAll(key).map(v => (typeof v === 'string' ? v : ''));
    out[key] = key.endsWith('[]') ? all : all[0];
  }
  for (const k of Object.keys(out)) if (k.endsWith('[]')) { out[k.slice(0, -2)] = out[k]; delete out[k]; }
  return out;
}

export async function handle<S extends z.ZodType>(
  schema: S, form: FormData, run: (input: z.output<S>) => Promise<ActionState | void>, extra: Record<string, unknown> = {},
): Promise<ActionState> {
  const parsed = schema.safeParse({ ...formObject(form), ...extra });
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrors(parsed.error), message: 'Check the highlighted fields.' };
  try {
    return (await run(parsed.data)) ?? { ok: true, message: 'Saved.' };
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message };
    // redirect()/notFound() work by throwing: let Next.js handle them.
    if (e && typeof e === 'object' && 'digest' in e) throw e;
    console.error('[admin action]', e);
    return { ok: false, message: 'Something went wrong. Nothing was changed.' };
  }
}
