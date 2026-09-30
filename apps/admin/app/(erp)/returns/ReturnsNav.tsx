import SubNav from '@/components/SubNav';

export default function ReturnsNav({ current }: { current: string }) {
  return <SubNav label="Returns" current={current} items={[{ href: '/returns', label: 'Return requests' }, { href: '/returns/report', label: 'Report' }]} />;
}
