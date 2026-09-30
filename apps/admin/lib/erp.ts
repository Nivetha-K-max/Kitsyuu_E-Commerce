/* Small helpers shared by the ERP module pages (pricing, shipping, returns, marketing, support, finance, carts). */
export type SP = Promise<Record<string, string | string[] | undefined>>;
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
/** Paise → the rupee text a money field expects ("2499" or "2499.50"); '' for none. */
export const rupeesField = (p: number | null | undefined) => (p === null || p === undefined ? '' : p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2));
/** A date as the value of <input type="datetime-local"> in India time; '' for none. */
export function istLocal(d: Date | string | null | undefined): string {
  if (!d) return '';
  const t = new Date(new Date(d).getTime() + 330 * 60_000);
  return t.toISOString().slice(0, 16);
}
export const istDate = (d: Date | string | null | undefined) => (d ? new Date(new Date(d).getTime() + 330 * 60_000).toISOString().slice(0, 10) : '');
/** Today and N days back as YYYY-MM-DD (India time), for report ranges. */
export function defaultRange(days = 30): { from: string; to: string } {
  const to = istDate(new Date());
  return { from: istDate(new Date(Date.now() - days * 86_400_000)), to };
}
export const pageOf = (v: string | string[] | undefined) => Math.min(10_000, Math.max(1, parseInt(one(v), 10) || 1));
export const bp = (v: number) => `${(v / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;
