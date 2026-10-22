import { useEffect } from 'react';
import { createBrowserRouter, RouterProvider, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authState } from './lib/auth';
import Layout from './components/Layout';
import { usePlaidConnect } from './components/plaid';
import Dashboard from './pages/Dashboard';
import Transactions from './pages/Transactions';
import Budgets from './pages/Budgets';
import Recurring from './pages/Recurring';
import Accounts from './pages/Accounts';
import Insights from './pages/Insights';
import Goals from './pages/Goals';
import SettingsLayout from './pages/settings/SettingsLayout';
import Overview from './pages/settings/Overview';
import Connections from './pages/settings/Connections';
import Categories from './pages/settings/Categories';
import Rules from './pages/settings/Rules';
import Appearance from './pages/settings/Appearance';
import Security from './pages/settings/Security';
import Data from './pages/settings/Data';
import More from './pages/More';
import { Login, Setup } from './pages/Auth';

// Plaid sends OAuth banks back here; resume Link with the same token, then go to Accounts.
function PlaidOAuth() {
  const nav = useNavigate();
  usePlaidConnect({ oauthReturn: true, onDone: () => nav('/accounts', { replace: true }) });
  return <div className="auth"><p className="muted">Finishing your bank connection…</p></div>;
}

// Data router: needed for native View Transitions on <Link viewTransition>.
const router = createBrowserRouter([
  { path: '/plaid-oauth', element: <PlaidOAuth /> },
  {
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'transactions', element: <Transactions /> },
      { path: 'budgets', element: <Budgets /> },
      { path: 'goals', element: <Goals /> },
      { path: 'recurring', element: <Recurring /> },
      { path: 'accounts', element: <Accounts /> },
      { path: 'insights', element: <Insights /> },
      {
        path: 'settings',
        element: <SettingsLayout />,
        children: [
          { index: true, element: <Overview /> },
          { path: 'connections', element: <Connections /> },
          { path: 'categories', element: <Categories /> },
          { path: 'rules', element: <Rules /> },
          { path: 'appearance', element: <Appearance /> },
          { path: 'security', element: <Security /> },
          { path: 'data', element: <Data /> },
          { path: '*', element: <Overview /> },
        ],
      },
      { path: 'more', element: <More /> },
      { path: '*', element: <Dashboard /> },
    ],
  },
]);

export default function App() {
  const qc = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: authState, staleTime: Infinity });
  useEffect(() => {
    const h = () => qc.setQueryData(['auth'], (s: { authenticated: boolean } | undefined) => (s ? { ...s, authenticated: false } : s));
    window.addEventListener('tally:unauthorized', h);
    return () => window.removeEventListener('tally:unauthorized', h);
  }, [qc]);

  const done = () => {
    qc.clear();
    auth.refetch();
  };

  if (location.pathname === '/setup') return <Setup onDone={() => { location.replace('/'); }} />;
  if (!auth.data) return <div className="auth" />;
  if (!auth.data.authenticated) return <Login hasPasskeys={auth.data.hasPasskeys} onDone={done} />;

  return <RouterProvider router={router} />;
}
