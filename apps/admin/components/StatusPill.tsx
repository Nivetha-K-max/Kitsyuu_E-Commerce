/* The one status pill used across the admin: a small dot and label on a soft tint (success / warning / danger /
   info / neutral by status). Safe in server and client components. */
import { STATUS_LABEL } from '@/lib/format';

export function StatusPill({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}</span>;
}
