import 'server-only';
import { currentCustomer } from '@/lib/server';

/** For signed-out pages (login, signup): true when a valid session exists. If the database cannot be reached the page
    still renders its form (the form's action then reports a friendly error) instead of failing. */
export async function isSignedIn(): Promise<boolean> {
  try { return !!(await currentCustomer()); } catch (e) { console.error('[auth pages]', e); return false; }
}
