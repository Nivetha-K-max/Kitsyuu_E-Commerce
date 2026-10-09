'use client';
/* The authentication code is not asked for up front. It appears only after the server has answered that this account
   signs in with two-factor (the answer names the field), so accounts without it never see it. */
import { Field, useFormState } from '@/components/forms';

export default function CodeField() {
  const needed = !!useFormState().fieldErrors?.code;
  return needed ? <Field name="code" label="Authentication code" autoComplete="one-time-code" /> : null;
}
