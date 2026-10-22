// Goal funding: link any number of accounts (whole balance, a fixed amount, or a percentage), see what's still
// free in each account, and show where a goal's money is held.
import { Link2, X, AlertTriangle, HandCoins } from 'lucide-react';
import { useAllocations } from '../lib/queries';
import { money } from '../lib/format';
import type { AccountAlloc, AllocMode, Goal, GoalSource } from '../lib/types';
import { Button, DataTable, IconButton, MoneyInput, PercentInput, Segmented, Select, vars } from './ui';

export type LinkDraft = { account_id: number; mode: AllocMode; amount: string; percent: string };

export const draftFromSources = (s: GoalSource[]): LinkDraft[] =>
  s.map((x) => ({ account_id: x.account_id, mode: x.mode, amount: x.amount != null ? String(x.amount) : '', percent: x.percent != null ? String(x.percent) : '' }));

export const valueOf = (d: LinkDraft, balance: number) => {
  const bal = Math.max(balance, 0);
  if (d.mode === 'full') return bal;
  if (d.mode === 'percent') return (bal * (Number(d.percent) || 0)) / 100;
  return Math.min(Number(d.amount.replace(/[$,]/g, '')) || 0, bal);
};

export const linksPayload = (drafts: LinkDraft[]) =>
  drafts.map((d) => ({ account_id: d.account_id, mode: d.mode, amount: d.mode === 'amount' ? Number(d.amount.replace(/[$,]/g, '')) || 0 : null, percent: d.mode === 'percent' ? Number(d.percent) || 0 : null }));

export const linksValid = (drafts: LinkDraft[]) =>
  drafts.every((d) => d.mode === 'full' || (d.mode === 'amount' ? Number(d.amount.replace(/[$,]/g, '')) > 0 : Number(d.percent) > 0 && Number(d.percent) <= 100));

const typeLabel = (t: string) => (t === 'depository' ? 'Cash' : t === 'investment' ? 'Investments' : 'Other');
const c0 = { cents: false } as const;

// Editor: one compact row per linked account. `goalId` is excluded from "already allocated" so editing a goal
// doesn't count against itself.
export function FundingEditor({ goalId, drafts, onChange }: { goalId?: number; drafts: LinkDraft[]; onChange: (d: LinkDraft[]) => void }) {
  const alloc = useAllocations();
  const accounts = alloc.data || [];
  const others = (a: AccountAlloc) => a.goals.filter((g) => g.goal_id !== goalId);
  const freeFor = (a: AccountAlloc) => a.balance - others(a).reduce((s, g) => s + g.value, 0);
  const set = (i: number, patch: Partial<LinkDraft>) => onChange(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const unused = accounts.filter((a) => !drafts.some((d) => d.account_id === a.account_id) && !a.hidden);

  return (
    <div className="stack tight">
      {drafts.length > 0 && (
        <div className="fund-list">
          {drafts.map((d, i) => {
            const a = accounts.find((x) => x.account_id === d.account_id);
            if (!a) return null;
            const free = freeFor(a);
            const v = valueOf(d, a.balance);
            const over = v > free + 0.5 || (d.mode === 'full' && others(a).length > 0);
            return (
              <div key={d.account_id} className={`fund-row ${over ? 'over' : ''}`}>
                <div className="fund-acct">
                  <div className="ellipsis strong">{a.label}{a.mask ? <span className="faint"> ··{a.mask}</span> : null}</div>
                  <div className="faint num small">{money(a.balance, c0)} · {money(Math.max(free, 0), c0)} free</div>
                </div>
                <Segmented size="sm" value={d.mode} onChange={(mode) => set(i, { mode, amount: d.amount || (mode === 'amount' ? String(Math.max(Math.floor(free), 0)) : ''), percent: d.percent || (mode === 'percent' ? '100' : '') })}
                  options={[{ value: 'full', label: 'All' }, { value: 'amount', label: 'Amount' }, { value: 'percent', label: '%' }]} />
                <div className="fund-input">
                  {d.mode === 'amount' && <MoneyInput sm value={d.amount} onChange={(x) => set(i, { amount: x })} step={100} invalid={over || !(Number(d.amount) > 0)} aria-label="Amount from this account" />}
                  {d.mode === 'percent' && <PercentInput sm value={d.percent} onChange={(x) => set(i, { percent: x })} aria-label="Percent of this account" />}
                </div>
                <span className="num fund-value">{money(v, c0)}</span>
                <IconButton size="sm" icon={<X />} label="Remove account" onClick={() => onChange(drafts.filter((_, j) => j !== i))} />
                {(over || (d.mode === 'amount' && free > 0 && Number(d.amount) !== Math.floor(free)) || (d.mode === 'percent' && a.type === 'investment')) && (
                  <div className="fund-note">
                    {over ? (
                      <span className="neg"><AlertTriangle size={12} /> {d.mode === 'full' && others(a).length ? `“All” overlaps with ${others(a).map((g) => g.name).join(', ')}, which also use this account.` : `More than the ${money(Math.max(free, 0), c0)} not already set aside for other goals.`}</span>
                    ) : d.mode === 'percent' ? (
                      <span className="faint">A percentage rises and falls with the market.</span>
                    ) : null}
                    {d.mode === 'amount' && free > 0 && Number(d.amount) !== Math.floor(free) && (
                      <Button size="sm" variant="ghost" onClick={() => set(i, { amount: String(Math.floor(free)) })}>Use all free ({money(free, c0)})</Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {unused.length > 0 && (
        <Select variant="add" value="" onChange={(e) => {
          const a = accounts.find((x) => x.account_id === Number(e.target.value));
          if (!a) return;
          const free = Math.max(Math.floor(freeFor(a)), 0);
          onChange([...drafts, { account_id: a.account_id, mode: others(a).length ? 'amount' : 'full', amount: String(free), percent: '' }]);
        }} aria-label="Add an account">
          <option value="">{drafts.length ? 'Add another account…' : 'Link an account…'}</option>
          {['depository', 'investment', 'other'].map((t) => {
            const list = unused.filter((a) => a.type === t);
            return list.length ? (
              <optgroup key={t} label={typeLabel(t)}>
                {list.map((a) => <option key={a.account_id} value={a.account_id}>{a.label}{a.mask ? ` ··${a.mask}` : ''} · {money(Math.max(freeFor(a), 0), c0)} free of {money(a.balance, c0)}</option>)}
              </optgroup>
            ) : null;
          })}
        </Select>
      )}
      {alloc.data && !accounts.length && <p className="faint small">Connect a bank to fund goals from real accounts.</p>}
    </div>
  );
}

type HeldRow = { key: string; label: string; sub: string; value: number; short: boolean; manual: boolean; shade: number };

// "Where it's held": a stacked bar plus one table row per source.
export function FundingBreakdown({ g }: { g: Goal }) {
  const shades = [1, 0.75, 0.55, 0.4, 0.3];
  const rows: HeldRow[] = [
    ...g.sources.map((s) => ({ key: `a${s.account_id}`, label: s.label, sub: s.mode === 'full' ? 'Whole balance' : s.mode === 'percent' ? `${Number(s.percent)}% of ${money(s.account_balance, c0)}` : `${money(s.amount, c0)} of ${money(s.account_balance, c0)}`, value: s.value, short: s.short, manual: false })),
    ...(Math.abs(g.entries_total) >= 0.005 ? [{ key: 'manual', label: g.sources.length ? 'Set aside separately' : 'Set aside by you', sub: 'Logged in Tally', value: g.entries_total, short: false, manual: true }] : []),
  ].map((r, i) => ({ ...r, shade: shades[i % shades.length] }));
  const total = rows.reduce((s, r) => s + Math.max(r.value, 0), 0) || 1;
  if (!rows.length) return <p className="faint small">Nothing funds this yet. Link an account or add money.</p>;
  return (
    <div className="stack tight">
      <div className="alloc-bar">{rows.map((r) => <i key={r.key} style={vars({ width: `${(Math.max(r.value, 0) / total) * 100}%`, background: g.color, opacity: r.shade })} />)}</div>
      <div className="mini-table">
        <DataTable
          sticky={false}
          rows={rows}
          rowKey={(r) => r.key}
          columns={[
            {
              key: 'src', header: 'Source', wide: true,
              cell: (r) => (
                <div className="cell">
                  <i className="legend-swatch" style={{ background: g.color, opacity: r.shade }} />
                  {r.manual ? <HandCoins size={13} className="faint" /> : <Link2 size={13} className="faint" />}
                  <span style={{ minWidth: 0, lineHeight: 1.3, padding: '4px 0' }}>
                    <span className="ellipsis" style={{ display: 'block' }}>{r.label}</span>
                    <span className={`ellipsis small ${r.short ? 'warn' : 'faint'}`} style={{ display: 'block' }}>{r.sub}{r.short ? ' · account has less' : ''}</span>
                  </span>
                </div>
              ),
            },
            { key: 'v', header: 'Amount', num: true, cell: (r) => <span className={r.value < 0 ? 'neg' : ''} style={{ fontWeight: 500 }}>{money(r.value, c0)}</span> },
          ]}
        />
      </div>
    </div>
  );
}

// Per-account allocation overview: which goals hold how much, and what's still free.
export function AllocationList({ accounts, onOpenGoal }: { accounts: AccountAlloc[]; onOpenGoal?: (id: number) => void }) {
  return (
    <div className="alloc-list">
      {accounts.map((a) => (
        <div key={a.account_id} className="alloc-acct">
          <div className="row between" style={{ gap: 10, marginBottom: 6 }}>
            <span className="ellipsis strong">{a.label}{a.mask ? <span className="faint" style={{ fontWeight: 400 }}> ··{a.mask}</span> : null}</span>
            <span className="num small nowrap">
              {a.over ? <span className="neg"><AlertTriangle size={12} /> Over by {money(a.allocated - a.balance, c0)}</span> : <><b>{money(a.free, c0)}</b> <span className="faint">free of {money(a.balance, c0)}</span></>}
            </span>
          </div>
          <div className="alloc-bar">
            {a.goals.map((g) => (
              <button key={g.goal_id} type="button" title={`${g.name}: ${money(g.value)}`} onClick={() => onOpenGoal?.(g.goal_id)}
                style={vars({ width: `${(g.value / Math.max(a.balance, a.allocated, 1)) * 100}%`, background: g.color })} />
            ))}
          </div>
          <div className="alloc-legend">
            {a.goals.map((g) => (
              <button key={g.goal_id} type="button" onClick={() => onOpenGoal?.(g.goal_id)}>
                <i style={{ background: g.color }} />{g.name} <span className="num faint">{money(g.value, c0)}{g.mode === 'percent' ? ` · ${Number(g.percent)}%` : ''}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
