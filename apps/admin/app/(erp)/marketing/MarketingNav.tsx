import SubNav from '@/components/SubNav';

export default function MarketingNav({ current }: { current: string }) {
  return <SubNav label="Marketing" module="marketing" current={current} items={[
    { href: '/marketing', label: 'Campaigns' }, { href: '/marketing/banners', label: 'Banners' },
    { href: '/marketing/segments', label: 'Segments' }, { href: '/marketing/subscribers', label: 'Subscribers' }, { href: '/marketing/report', label: 'Report' },
  ]} />;
}
