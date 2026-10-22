// ⌘K / Ctrl+K / "/" command palette: jump anywhere, search transactions, run actions.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, CalendarClock, Database, Download, Eye, EyeOff, Home, KeyRound, Landmark, LineChart, Moon, Palette, PieChart, Search, Settings, Sun, Tag, Tags, Target, Wand2 } from 'lucide-react';
import { getPrivacy, setPrivacy, setTheme } from '../lib/prefs';
import { api } from '../lib/api';
import { useAccounts, useCategories } from '../lib/queries';
import { prettyName, shortDate, txnAmount } from '../lib/format';
import type { Txn } from '../lib/types';
import { useClosing } from './ui';
import TxnSheet from './TxnSheet';

type Item = { id: string; group: string; label: string; hint?: string; icon: ReactNode; run: () => void };

export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  return [open, setOpen] as const;
}

export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [closing, close] = useClosing(onClose, 100);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [sel, setSel] = useState(0);
  const [txn, setTxn] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { data: cats } = useCategories();
  const accounts = useAccounts();
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 160);
    return () => clearTimeout(t);
  }, [q]);
  const found = useQuery({
    queryKey: ['palette-search', dq],
    queryFn: () => api<{ items: Txn[] }>(`/transactions?q=${encodeURIComponent(dq)}&limit=6`),
    enabled: dq.length >= 2,
  });

  const go = (to: string) => () => {
    close();
    nav(to, { viewTransition: true });
  };
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (s: string) => !needle || s.toLowerCase().includes(needle);
    const out: Item[] = [];
    const pages: [string, string, ReactNode][] = [
      ['Dashboard', '/', <Home />], ['Transactions', '/transactions', <ArrowLeftRight />], ['Budgets', '/budgets', <PieChart />], ['Goals', '/goals', <Target />],
      ['Recurring', '/recurring', <CalendarClock />], ['Accounts', '/accounts', <Landmark />], ['Cash Flow', '/insights', <LineChart />], ['Settings', '/settings', <Settings />],
      ['Bank connections', '/settings/connections', <Landmark />], ['Categories', '/settings/categories', <Tags />], ['Rules', '/settings/rules', <Wand2 />],
      ['Appearance', '/settings/appearance', <Palette />], ['Passkeys & sign-in', '/settings/security', <KeyRound />], ['Data & privacy', '/settings/data', <Database />],
    ];
    for (const [label, to, icon] of pages) if (match(label) && (needle || !to.startsWith('/settings/'))) out.push({ id: `p${to}`, group: 'Go to', label, icon, run: go(to) });
    const actions: Item[] = [
      { id: 'a-review', group: 'Actions', label: 'Review new transactions', icon: <ArrowLeftRight />, run: go('/transactions?review=1') },
      { id: 'a-dark', group: 'Actions', label: 'Switch to dark mode', icon: <Moon />, run: () => { setTheme('dark'); close(); } },
      { id: 'a-light', group: 'Actions', label: 'Switch to light mode', icon: <Sun />, run: () => { setTheme('light'); close(); } },
      getPrivacy()
        ? { id: 'a-privacy', group: 'Actions', label: 'Show amounts (privacy off)', icon: <Eye />, run: () => { setPrivacy(false); close(); } }
        : { id: 'a-privacy', group: 'Actions', label: 'Hide amounts (privacy mode)', icon: <EyeOff />, run: () => { setPrivacy(true); close(); } },
      { id: 'a-goal', group: 'Actions', label: 'Create a goal or bucket', icon: <Target />, run: go('/goals') },
      { id: 'a-rule', group: 'Actions', label: 'Create a rule', icon: <Wand2 />, run: go('/settings/rules') },
      { id: 'a-export', group: 'Actions', label: 'Export transactions (CSV)', icon: <Download />, run: () => { location.href = '/api/export/transactions.csv'; close(); } },
    ];
    out.push(...actions.filter((a) => match(a.label)));
    if (needle) {
      for (const c of (cats?.categories || []).filter((c) => !c.archived && match(c.name)).slice(0, 5))
        out.push({ id: `c${c.id}`, group: 'Categories', label: c.name, hint: 'Transactions', icon: <span>{c.emoji}</span>, run: go(`/transactions?category=${c.id}`) });
      for (const a of (accounts.data || []).filter((a) => match(a.label) || match(a.institution_name || '')).slice(0, 4))
        out.push({ id: `ac${a.id}`, group: 'Accounts', label: a.label, hint: a.institution_name || '', icon: <Landmark />, run: go(`/transactions?account=${a.id}`) });
      for (const t of found.data?.items || [])
        out.push({ id: `t${t.id}`, group: 'Transactions', label: prettyName(t.label), hint: `${shortDate(t.date)} · ${txnAmount(t.amount)}`, icon: <Tag />, run: () => setTxn(t.id) });
    }
    return out;
  }, [q, cats, accounts.data, found.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[sel]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };

  if (txn != null) return <TxnSheet id={txn} onClose={onClose} />;

  let lastGroup = '';
  return createPortal(
    <>
      <div className={`overlay ${closing ? 'closing' : ''}`} style={{ zIndex: 70 }} onClick={close} />
      <div className={`palette ${closing ? 'closing' : ''}`} role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <Search />
          <input autoFocus placeholder="Search or jump to…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} aria-label="Search" />
        </div>
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">{found.isFetching ? 'Searching…' : 'No results'}</div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? <div className="palette-group">{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {head}
                <button type="button" className={`palette-item ${i === sel ? 'on' : ''}`} onMouseMove={() => setSel(i)} onClick={it.run}>
                  <span className="ic">{it.icon}</span>
                  <span className="ellipsis">{it.label}</span>
                  {it.hint && <span className="hint">{it.hint}</span>}
                  <span className="kbd enter">↵</span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot desktop-only">
          <span><span className="kbd">↑</span> <span className="kbd">↓</span> move</span>
          <span><span className="kbd">↵</span> open</span>
          <span><span className="kbd">esc</span> close</span>
          <span style={{ marginLeft: 'auto' }}><span className="kbd">{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</span> or <span className="kbd">/</span> anywhere</span>
        </div>
      </div>
    </>,
    document.body,
  );
}
