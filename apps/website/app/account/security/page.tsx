import type { Metadata } from 'next';
import { listCustomerSessions } from '@kitsyuu/auth';
import { EndSessionButton, LogoutEverywhereButton, PasswordForm } from '@/components/AccountForms';
import { Card } from '@/components/account-ui';
import { AccountIcons } from '@/components/icons';
import { accountProfile } from '@/lib/account-data';
import { db, requireCustomer } from '@/lib/server';
import { formatDate, formatDateTime } from '@/lib/account-format';

export const metadata: Metadata = { title: 'Security' };

/** A short, human description of a browser from its user agent (never shown raw). */
function device(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iPhone / iPad' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'unknown system';
  return `${browser} on ${os}`;
}

export default async function SecurityPage() {
  const me = await requireCustomer('/account/security');
  const [profile, sessions] = await Promise.all([accountProfile(me), listCustomerSessions(db(), me)]);
  return (
    <>
      <header className="st-plp-head">
        <h1 id="st-page-title">Security</h1>
        <div className="st-plp-aside"><p className="st-result-count">Password and devices</p><p>Password last changed {profile.passwordChangedAt ? formatDate(profile.passwordChangedAt) : 'before your account moved to the new KITSYUU sign-in'}.</p></div>
      </header>
      <div className="st-acc-grid">
        <Card id="st-sec-pw" title="Change password">
          <p className="st-acc-quiet">Changing your password signs you out on your other devices.</p>
          <PasswordForm />
        </Card>
        <Card id="st-sec-sessions" title="Where you are signed in">
          <ul className="st-session-list" data-sessions>
            {sessions.map(s => (
              <li key={s.id} data-session={s.current ? 'current' : 'other'}>
                <span className="st-session-ico">{AccountIcons.device}</span>
                <div><p className="st-session-device">{device(s.userAgent)}{s.current && <span className="st-address-tag">This device</span>}</p>
                  <p className="st-session-meta">Signed in {formatDate(s.createdAt)} · last active {formatDateTime(s.lastSeenAt)}</p></div>
                {!s.current && <EndSessionButton sessionId={s.id} device={device(s.userAgent)} />}
              </li>
            ))}
          </ul>
          <LogoutEverywhereButton />
        </Card>
      </div>
    </>
  );
}
