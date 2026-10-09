/* The fields of a vendor, shared by "New vendor" (the list) and "Edit details" (the vendor's page). */
import { Field, Hidden, TextArea } from '@/components/forms';

export type VendorValues = { id: string; name: string; contact: string | null; email: string | null; phone: string | null; gstin: string | null; address: string | null; notes: string | null };

export function VendorFields({ v }: { v?: VendorValues }) {
  return (
    <>
      {v && <Hidden name="vendorId" value={v.id} />}
      <div className="cols">
        <Field name="name" label="Name" defaultValue={v?.name} required />
        <Field name="contact" label="Contact person" defaultValue={v?.contact ?? ''} />
        <Field name="email" label="Email" type="email" defaultValue={v?.email ?? ''} />
        <Field name="phone" label="Phone" defaultValue={v?.phone ?? ''} />
        <Field name="gstin" label="GSTIN" defaultValue={v?.gstin ?? ''} hint="Optional, 15 characters." />
      </div>
      <TextArea name="address" label="Address" defaultValue={v?.address ?? ''} rows={2} />
      <TextArea name="notes" label="Notes (staff only)" defaultValue={v?.notes ?? ''} rows={2} />
    </>
  );
}
