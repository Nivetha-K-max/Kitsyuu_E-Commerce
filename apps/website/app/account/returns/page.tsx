import type { Metadata } from 'next';
import Link from 'next/link';
import { listCustomerReturns, returnSettings } from '@kitsyuu/core';
import { formatDate } from '@/lib/account-format';
import { RETURN_STATUS_LABEL } from '@/lib/erp-format';
import { returnsPolicy } from '@/lib/store-policy';
import { db, requireCustomer } from '@/lib/server';

export const metadata: Metadata = { title: 'Returns' };

export default async function ReturnsPage() {
  const me = await requireCustomer('/account/returns');
  const [rows, settings] = await Promise.all([listCustomerReturns(db(), me), returnSettings(db())]);
  return (
    <>
      <header className="st-plp-head"><h1 id="st-page-title">Returns</h1><div className="st-plp-aside"><p data-returns-policy>{returnsPolicy(settings)}</p></div></header>
      {rows.length === 0 ? <p className="st-empty-inline" data-no-returns>You have no return requests.{settings.enabled && settings.windowDays ? ' To request one, open a delivered order.' : ''}</p> : (
        <ul className="st-erp-list" data-returns-list>{rows.map(r => (
          <li key={r.id}><Link href={`/account/returns/${r.number}`}><b>{r.number}</b> · Order {r.order_number}</Link>
            <span>{RETURN_STATUS_LABEL[r.status] ?? r.status} · requested {formatDate(r.requested_at as Date)}</span></li>
        ))}</ul>
      )}
    </>
  );
}
