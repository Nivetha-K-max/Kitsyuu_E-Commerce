'use client';
/* M18: two-factor sign-in panel on My account. The secret and the recovery codes are shown once, only in this browser
   tab, right after the step that created them. */
import { startTransition, useActionState } from 'react';
import { confirmMfaAction, disableMfaAction, startMfaAction, type MfaState } from '@/app/(erp)/account/mfa-actions';

type Status = { available: boolean; enabled: boolean; pending: boolean; recoveryCodesLeft: number };

export default function TwoFactorPanel({ status }: { status: Status }) {
  const [started, start, starting] = useActionState<MfaState>(startMfaAction, {});
  const [confirmed, confirm, confirming] = useActionState<MfaState, FormData>(confirmMfaAction, {});
  const [disabled, disable, disabling] = useActionState<MfaState, FormData>(disableMfaAction, {});
  const scan = confirmed.step !== 'codes' && (started.step === 'scan' ? started : null);
  const on = (status.enabled || confirmed.step === 'codes') && disabled.step !== 'off';

  if (!status.available && !status.enabled) return <p className="note" data-mfa="unavailable">Two-factor sign-in is not set up on this server yet (an administrator adds MFA_ENCRYPTION_KEY).</p>;
  return (
    <div className="mfa" data-mfa={on ? 'on' : 'off'}>
      {confirmed.step === 'codes' && confirmed.codes && (
        <div className="msg ok" role="status" data-recovery-codes>
          <p><b>Two-factor sign-in is on.</b> Save these recovery codes somewhere safe. Each works once if you lose your phone. They are not shown again.</p>
          <ul className="codes">{confirmed.codes.map(c => <li key={c} className="mono">{c}</li>)}</ul>
        </div>
      )}
      {on ? (
        <>
          {confirmed.step !== 'codes' && <p className="note">On. {status.recoveryCodesLeft} unused recovery code(s) left.</p>}
          <form className="form compact" onSubmit={e => { e.preventDefault(); const d = new FormData(e.currentTarget); startTransition(() => disable(d)); }} data-mfa-disable>
            <div className="field"><label htmlFor="mfa-pw">Current password (to switch it off)</label><input id="mfa-pw" name="password" type="password" className="input" autoComplete="current-password" /></div>
            {disabled.error && <p className="msg error" role="alert">{disabled.error}</p>}
            <div className="actions"><button type="submit" className="btn danger" disabled={disabling}>Switch off two-factor</button></div>
          </form>
        </>
      ) : scan ? (
        <form className="form compact" onSubmit={e => { e.preventDefault(); const d = new FormData(e.currentTarget); startTransition(() => confirm(d)); }} data-mfa-confirm>
          <p>1. In your authenticator app, add an account with this key (or open the link on your phone):</p>
          <p className="mono mfa-secret" data-mfa-secret>{scan.secret}</p>
          <p className="note"><a href={scan.uri}>Open in an authenticator app</a></p>
          <div className="field"><label htmlFor="mfa-code">2. Enter the 6-digit code it shows</label><input id="mfa-code" name="code" inputMode="numeric" autoComplete="one-time-code" className="input" /></div>
          {confirmed.error && <p className="msg error" role="alert">{confirmed.error}</p>}
          <div className="actions"><button type="submit" className="btn" disabled={confirming}>Switch on</button></div>
        </form>
      ) : (
        <>
          <p className="note">Off. With it on, signing in also needs a code from an authenticator app on your phone.</p>
          {(started.error || disabled.step === 'off') && <p className={`msg ${started.error ? 'error' : 'ok'}`} role="status">{started.error ?? 'Two-factor sign-in is off.'}</p>}
          <div className="actions"><button type="button" className="btn" disabled={starting} onClick={() => startTransition(() => start())} data-mfa-start>Set up two-factor sign-in</button></div>
        </>
      )}
    </div>
  );
}
