'use client';
/* ERP module 1: a coupon code at checkout. The server checks the code and re-prices the cart; the page then shows whether
   it applies (and why not). Shown only while the business has discounts switched on. */
import { applyCouponAction, removeCouponAction } from '@/app/checkout/actions';
import { ActionForm, Field } from './forms';

export default function CouponForm({ code, applied, message }: { code: string | null; applied: boolean; message: string | null }) {
  return (
    <div className="st-coupon" data-coupon>
      {code ? (
        <>
          <p className={applied ? 'st-form-ok' : 'st-form-alert'} role="status" data-coupon-state={applied ? 'applied' : 'not-applied'}>
            Coupon <b>{code}</b>{applied ? ' applied.' : `: ${message ?? 'does not apply to this order.'}`}
          </p>
          <ActionForm action={removeCouponAction} submitLabel="Remove coupon" buttonClass="text-link" className="st-coupon-form" label="Remove coupon" id="st-coupon-remove" />
        </>
      ) : (
        <ActionForm action={applyCouponAction} submitLabel="Apply" pendingLabel="Checking…" buttonClass="button button-outline" className="st-coupon-form" label="Coupon code" id="st-coupon-form">
          <Field name="code" label="Coupon code" autoComplete="off" maxLength={32} />
        </ActionForm>
      )}
    </div>
  );
}
