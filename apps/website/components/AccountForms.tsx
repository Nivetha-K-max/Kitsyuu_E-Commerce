'use client';
/* Customer account forms (M6). The server actions (app/account/actions.ts) validate everything and act only on the
   signed-in customer's own rows. */
import { INDIAN_STATES } from '@kitsyuu/contracts/constants';   // not the package root: that would ship zod to the browser
import type { CustomerAddress } from '@kitsyuu/core';
import { ActionForm, CheckField, Field, Hidden, SelectField } from './forms';
import {
  changePasswordAction, deleteAddressAction, endSessionAction, logoutEverywhereAction, saveAddressAction, setDefaultAddressAction, updateProfileAction,
} from '@/app/account/actions';
import { cancelOrderAction } from '@/app/checkout/actions';

export function ProfileForm({ fullName, phone }: { fullName: string | null; phone: string | null }) {
  return (
    <ActionForm action={updateProfileAction} submitLabel="Save details" pendingLabel="Saving…" label="Personal information" id="st-profile-form">
      <Field name="fullName" label="Full name" autoComplete="name" defaultValue={fullName} required />
      <Field name="phone" label="Mobile number" type="tel" inputMode="tel" autoComplete="tel-national" defaultValue={phone}
        hint="Optional. A 10-digit Indian mobile number, used only about your orders." />
    </ActionForm>
  );
}

/** next: where to go after saving (only the checkout, which sends customers here to add an address). */
export function AddressForm({ address, next }: { address?: CustomerAddress; next?: '/checkout' }) {
  return (
    <ActionForm action={saveAddressAction} submitLabel={address ? 'Save address' : 'Add address'} pendingLabel="Saving…"
      label={address ? 'Edit address' : 'Add an address'} id="st-address-form" className="st-auth-form st-address-form">
      {address && <Hidden name="addressId" value={address.id} />}
      {next && <Hidden name="next" value={next} />}
      <Field name="fullName" label="Full name" autoComplete="name" defaultValue={address?.fullName} required />
      <Field name="phone" label="Mobile number" type="tel" inputMode="tel" autoComplete="tel-national" defaultValue={address?.phone} required
        hint="10-digit Indian mobile number, for the delivery partner." />
      <Field name="line1" label="House, building and street" autoComplete="address-line1" defaultValue={address?.line1} required />
      <Field name="line2" label="Area or landmark" autoComplete="address-line2" defaultValue={address?.line2} hint="Optional." />
      <Field name="city" label="City or town" autoComplete="address-level2" defaultValue={address?.city} required />
      <SelectField name="state" label="State or union territory" options={INDIAN_STATES} defaultValue={address?.state} required placeholder="Choose a state…" />
      <Field name="pin" label="PIN code" inputMode="numeric" autoComplete="postal-code" maxLength={6} defaultValue={address?.pin} required />
      {!address?.isDefault && <CheckField name="isDefault" label="Use as my default address" />}
    </ActionForm>
  );
}

export function AddressActions({ address }: { address: CustomerAddress }) {
  return (
    <div className="st-address-actions">
      {!address.isDefault && (
        <ActionForm action={setDefaultAddressAction} submitLabel="Make default" pendingLabel="Saving…" className="st-inline-form" buttonClass="st-link-button"
          label={`Make ${address.line1} the default address`}>
          <Hidden name="addressId" value={address.id} />
        </ActionForm>
      )}
      <ActionForm action={deleteAddressAction} submitLabel="Remove" pendingLabel="Removing…" className="st-inline-form" buttonClass="st-link-button st-danger"
        label={`Remove the address ${address.line1}`} confirmText={`Remove the address "${address.line1}, ${address.city}"?`}>
        <Hidden name="addressId" value={address.id} />
      </ActionForm>
    </div>
  );
}

export function PasswordForm() {
  return (
    <ActionForm action={changePasswordAction} submitLabel="Change password" pendingLabel="Saving…" label="Change password" id="st-password-form" resetOnSuccess>
      <Field name="current" label="Current password" type="password" autoComplete="current-password" required />
      <Field name="password" label="New password" type="password" autoComplete="new-password" required hint="At least 12 characters." />
      <Field name="confirm" label="Repeat new password" type="password" autoComplete="new-password" required />
    </ActionForm>
  );
}

export function EndSessionButton({ sessionId, device }: { sessionId: string; device: string }) {
  return (
    <ActionForm action={endSessionAction} submitLabel="Sign out" pendingLabel="Signing out…" className="st-inline-form" buttonClass="st-link-button"
      label={`Sign out ${device}`}>
      <Hidden name="sessionId" value={sessionId} />
    </ActionForm>
  );
}

/** Signs out every device including this one (plain form post to the server action). */
export function LogoutEverywhereButton() {
  return (
    <form action={logoutEverywhereAction} onSubmit={e => { if (!window.confirm('Sign out on every device, including this one?')) e.preventDefault(); }}>
      <button className="button button-outline" type="submit" data-logout-everywhere>Sign out everywhere</button>
    </form>
  );
}

export function CancelOrderButton({ orderNumber }: { orderNumber: string }) {
  return (
    <ActionForm action={cancelOrderAction} submitLabel="Cancel order" pendingLabel="Cancelling…" className="st-inline-form" buttonClass="button button-outline"
      label={`Cancel order ${orderNumber}`} confirmText={`Cancel order ${orderNumber}? Its items go back on sale.`} id="st-cancel-order">
      <Hidden name="orderNumber" value={orderNumber} />
    </ActionForm>
  );
}
