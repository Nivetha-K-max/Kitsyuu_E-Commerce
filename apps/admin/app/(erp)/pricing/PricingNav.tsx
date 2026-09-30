import SubNav from '@/components/SubNav';

export default function PricingNav({ current }: { current: string }) {
  return <SubNav label="Pricing" current={current} items={[
    { href: '/pricing', label: 'Products' }, { href: '/pricing/discounts', label: 'Discounts & coupons' },
    { href: '/pricing/scheduled', label: 'Scheduled changes' }, { href: '/pricing/history', label: 'Price history' },
  ]} />;
}
