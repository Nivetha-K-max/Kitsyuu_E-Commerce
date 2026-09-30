import SubNav from '@/components/SubNav';

export default function MarketingNav({ current }: { current: string }) {
  return <SubNav label="Marketing" current={current} items={[
    { href: '/marketing', label: 'Campaigns' }, { href: '/marketing/banners', label: 'Banners' },
    { href: '/marketing/segments', label: 'Customer segments' }, { href: '/marketing/subscribers', label: 'Newsletter subscribers' }, { href: '/marketing/report', label: 'Promotion report' },
  ]} />;
}
