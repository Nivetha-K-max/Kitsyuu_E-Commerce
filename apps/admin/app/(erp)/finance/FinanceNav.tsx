import SubNav from '@/components/SubNav';

export default function FinanceNav({ current }: { current: string }) {
  return <SubNav label="Finance" current={current} items={[
    { href: '/finance', label: 'Summary' }, { href: '/finance/invoices', label: 'Invoices' }, { href: '/finance/notes', label: 'Credit & debit notes' },
    { href: '/finance/expenses', label: 'Expenses' }, { href: '/finance/vendor-payments', label: 'Vendor payments' }, { href: '/finance/tax', label: 'Tax' },
    { href: '/finance/reconciliation', label: 'Reconciliation' },
  ]} />;
}
