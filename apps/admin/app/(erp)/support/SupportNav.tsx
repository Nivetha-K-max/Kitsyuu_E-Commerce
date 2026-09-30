import SubNav from '@/components/SubNav';

export default function SupportNav({ current, manage }: { current: string; manage: boolean }) {
  return <SubNav label="Support" current={current} items={[
    { href: '/support', label: 'Tickets' }, { href: '/support/new', label: 'New ticket', show: manage }, { href: '/support/report', label: 'Report' },
  ]} />;
}
