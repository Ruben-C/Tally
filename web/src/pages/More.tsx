import { Link } from 'react-router';
import { CalendarClock, ChevronRight, Landmark, LineChart, Settings } from 'lucide-react';
import { Page, PageHeader, Panel } from '../components/ui';

const LINKS = [
  { to: '/accounts', label: 'Accounts', sub: 'Balances and net worth over time', icon: Landmark },
  { to: '/recurring', label: 'Recurring', sub: 'Subscriptions, bills and paychecks', icon: CalendarClock },
  { to: '/insights', label: 'Cash Flow', sub: 'Income vs spending, by month', icon: LineChart },
  { to: '/settings', label: 'Settings', sub: 'Connections, categories, rules, appearance, security', icon: Settings },
];

export default function More() {
  return (
    <Page>
      <PageHeader title="More" />
      <Panel flush className="settings-menu-list">
        <div className="list">
          {LINKS.map(({ to, label, sub, icon: Icon }) => (
            <Link viewTransition key={to} to={to} className="rowlink">
              <Icon />
              <span className="grow">
                <span style={{ display: 'block', fontWeight: 500 }}>{label}</span>
                <span className="sub ellipsis" style={{ display: 'block' }}>{sub}</span>
              </span>
              <ChevronRight size={16} className="faint" />
            </Link>
          ))}
        </div>
      </Panel>
    </Page>
  );
}
