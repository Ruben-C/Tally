// The one way transactions are listed anywhere (Transactions, Dashboard review queue, account and goal drill-downs).
import type { Key } from 'react';
import { Repeat, Split } from 'lucide-react';
import { useAccounts, useCategories } from '../lib/queries';
import { dayLabel, prettyName, shortDate, txnAmount } from '../lib/format';
import type { Txn } from '../lib/types';
import { Badge, CatLabel, DataTable, MerchantAvatar, type Column, type TableGroup } from './ui';

export function TxnTable({
  rows, byDay = false, onOpen, onPickCategory, selectedId, showDate = !byDay, showAccount = true, showNotes = true, showCategory = true, sticky = true, select, loading, empty, onKeyAction, skeletonRows,
}: {
  rows: Txn[];
  /** Group under day headers with day totals (the Date column is dropped). */
  byDay?: boolean;
  onOpen?: (t: Txn) => void;
  /** Clicking the category cell opens a picker for just that row. */
  onPickCategory?: (t: Txn) => void;
  selectedId?: number | null;
  showDate?: boolean;
  showAccount?: boolean;
  showNotes?: boolean;
  showCategory?: boolean;
  /** Off inside sheets/rails where the page header isn't above the table. */
  sticky?: boolean;
  select?: { selected: Set<Key>; onChange: (next: Set<Key>) => void };
  loading?: boolean;
  empty?: React.ReactNode;
  onKeyAction?: Record<string, (t: Txn) => void>;
  skeletonRows?: number;
}) {
  const { byId } = useCategories();
  const accounts = useAccounts();
  const acct = (id: number) => accounts.data?.find((a) => a.id === id);
  // A split shows its biggest line's category and how many others share it.
  const splitText = (t: Txn) => {
    const top = [...(t.splits || [])].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
    const c = top ? byId.get(top.category_id) : null;
    return `${c ? `${c.emoji} ${c.name}` : 'Split'} +${(t.splits?.length || 1) - 1}`;
  };
  const splitTitle = (t: Txn) => (t.splits || []).map((l) => `${byId.get(l.category_id)?.name ?? '?'} ${txnAmount(l.amount)}`).join(' · ');

  const columns: Column<Txn>[] = [
    ...(showDate ? [{ key: 'date', header: 'Date', shrink: true, hide: 'sm' as const, cell: (t: Txn) => <span className="muted num">{shortDate(t.date)}</span> }] : []),
    {
      key: 'name', header: 'Merchant', wide: true,
      cell: (t) => {
        const cat = t.category_id ? byId.get(t.category_id) : null;
        return (
          <div className="cell">
            <i className={`unrev ${t.reviewed ? 'off' : ''}`} title={t.reviewed ? undefined : 'Needs review'} />
            <MerchantAvatar name={t.label} logo={t.logo_url} cat={cat} size="sm" />
            <span className="ellipsis primary strike">{prettyName(t.label)}</span>
            {t.recurring_id && <Repeat size={12} className="faint" style={{ flex: 'none' }} aria-label="Recurring" />}
            {t.goal_id && <Badge title={`Linked to ${t.goal_name}`}>{t.goal_emoji} {t.goal_name}</Badge>}
            {t.pending && <Badge tone="warn">Pending</Badge>}
          </div>
        );
      },
      sub: (t) => {
        const cat = t.category_id ? byId.get(t.category_id) : null;
        if (t.splits?.length) return <span title={splitTitle(t)}>Split · {splitText(t)}{showDate ? ` · ${shortDate(t.date)}` : ''}</span>;
        return <>{cat ? `${cat.emoji} ${cat.name}` : 'Uncategorized'}{showDate ? ` · ${shortDate(t.date)}` : ''}</>;
      },
    },
    ...(!showCategory ? [] : [{
      key: 'cat', header: 'Category', hide: 'sm' as const, width: 190,
      cell: (t: Txn) => {
        if (t.splits?.length)
          return <span className="split-cell muted" title={splitTitle(t)}><Split size={12} className="faint" /> <span className="ellipsis">{splitText(t)}</span></span>;
        const cat = t.category_id ? byId.get(t.category_id) : null;
        return <CatLabel cat={cat} onClick={onPickCategory ? () => onPickCategory(t) : undefined} />;
      },
    } as Column<Txn>]),
    ...(showAccount
      ? [{ key: 'acct', header: 'Account', hide: 'md' as const, width: 170, cell: (t: Txn) => { const a = acct(t.account_id); return <span className="muted ellipsis" style={{ display: 'block', maxWidth: 170 }}>{a ? `${a.label}${a.mask ? ` ··${a.mask}` : ''}` : '—'}</span>; } }]
      : []),
    ...(showNotes ? [{ key: 'notes', header: 'Notes', hide: 'lg' as const, width: 200, cell: (t: Txn) => <span className="faint ellipsis" style={{ display: 'block', maxWidth: 200 }} title={t.notes || undefined}>{t.notes || (t.tags?.length ? t.tags.map((x) => `#${x}`).join(' ') : '')}</span> }] : []),
    { key: 'amt', header: 'Amount', num: true, shrink: true, cell: (t) => <span className={`strike ${t.amount < 0 ? 'pos' : ''}`} style={{ fontWeight: 500 }}>{txnAmount(t.amount)}</span> },
  ];

  const groups: TableGroup<Txn>[] | undefined = byDay
    ? (() => {
        const out: TableGroup<Txn>[] = [];
        let total = 0;
        for (const t of rows) {
          let g = out[out.length - 1];
          if (!g || g.key !== t.date) {
            if (g) g.right = txnAmount(Math.round(total * 100) / 100);
            out.push((g = { key: t.date, label: dayLabel(t.date), rows: [] }));
            total = 0;
          }
          g.rows.push(t);
          if (!t.excluded) total += t.amount;
        }
        if (out.length) out[out.length - 1].right = txnAmount(Math.round(total * 100) / 100);
        return out;
      })()
    : undefined;

  return (
    <DataTable
      columns={columns}
      rows={byDay ? undefined : rows}
      groups={groups}
      rowKey={(t) => t.id}
      onRowClick={onOpen}
      selected={selectedId}
      rowClass={(t) => t.excluded && 'dim'}
      loading={loading}
      skeletonRows={skeletonRows}
      empty={empty}
      select={select}
      onKeyAction={onKeyAction}
      className="txn-table"
      sticky={sticky}
    />
  );
}
