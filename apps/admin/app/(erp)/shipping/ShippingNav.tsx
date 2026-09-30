import SubNav from '@/components/SubNav';

export default function ShippingNav({ current }: { current: string }) {
  return <SubNav label="Shipping" current={current} items={[
    { href: '/shipping', label: 'Shipments' }, { href: '/shipping/zones', label: 'Zones & rates' },
    { href: '/shipping/couriers', label: 'Couriers' }, { href: '/shipping/report', label: 'Report' },
  ]} />;
}
