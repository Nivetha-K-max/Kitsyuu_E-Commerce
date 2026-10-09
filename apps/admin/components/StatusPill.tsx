/* The one status pill used across the admin: a small dot and label on a soft tint (success / warning / danger /
   info / neutral by status). Safe in server and client components. */
import { STATUS_LABEL } from '@/lib/format';

export function StatusPill({ status, label }: { status: string; /** Wording for this status in one place (the colour still follows the status). */ label?: string }) {
  // A given label is shown exactly as written (badges otherwise capitalise every word: "In Stock").
  return <span className={`badge ${status}${label ? ' as-written' : ''}`}>{label ?? STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}</span>;
}

/** A product's status. A product that is 'active' is published in the store, so it reads "Published" (as the Products
    views do), and one submitted for approval ('review') reads "Pending approval", the name of its view. The stored values
    are unchanged and other records (staff, customers, purchase orders…) keep their own wording. */
const PRODUCT_STATUS_LABEL: Record<string, string> = { active: 'Published', review: 'Pending approval' };
export function ProductStatusPill({ status }: { status: string }) {
  return <StatusPill status={status} label={PRODUCT_STATUS_LABEL[status]} />;
}
