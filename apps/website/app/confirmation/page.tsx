import { redirect } from 'next/navigation';

/* The prototype confirmation page is gone: order confirmations live at /checkout/complete/<order> and in the account. */
export default function Page() { redirect('/account/orders'); }
