import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, Pencil, Play, Plus, Target, Trash2, Wand2, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useAccounts, useCategories, useGoals, useMutate, useRules } from '../../lib/queries';
import { isoFromToday, money, prettyName, shortDate, todayIso, txnAmount } from '../../lib/format';
import type { Rule, Txn } from '../../lib/types';
import {
  AddonSelect, Badge, Button, CatLabel, DataTable, DateInput, Empty, Field, IconButton, Input, Modal, MoneyInput, MoneyRange, Panel, PickerButton, SearchInput, Segmented, Select, Sheet, Switch, useToast,
} from '../../components/ui';
import { CategoryPicker } from '../../components/TxnSheet';
import { SettingsHeader } from './SettingsLayout';

const OPS = { contains: 'contains', equals: 'is exactly', starts_with: 'starts with' } as const;

function RuleSentence({ r, account }: { r: Pick<Rule, 'field' | 'op' | 'pattern' | 'amount_min' | 'amount_max'> & { direction?: Rule['direction'] }; account?: string | null }) {
  const dir = r.direction === 'in' ? 'money comes in' : r.direction === 'out' ? 'money goes out' : null;
  return (
    <span>
      When {dir ? <b>{dir}</b> : r.pattern ? null : 'a transaction arrives'}{account ? <> {dir ? 'to' : 'in'} <b className="rule-token">{account}</b></> : null}
      {r.pattern ? <>{dir || account ? ' and ' : ''}the {r.field === 'merchant' ? 'merchant' : 'bank description'} {OPS[r.op]} <b className="rule-token">{r.pattern}</b></> : null}
      {r.amount_min != null && r.amount_max != null ? <> and the amount is between <b>{money(r.amount_min)}</b> and <b>{money(r.amount_max)}</b></>
        : r.amount_min != null ? <> and the amount is over <b>{money(r.amount_min)}</b></>
        : r.amount_max != null ? <> and the amount is under <b>{money(r.amount_max)}</b></> : null}
    </span>
  );
}

const amountRange = (r: Pick<Rule, 'amount_min' | 'amount_max'>) =>
  r.amount_min != null && r.amount_max != null ? `${money(r.amount_min, { cents: false })}–${money(r.amount_max, { cents: false })}`
    : r.amount_min != null ? `> ${money(r.amount_min, { cents: false })}` : r.amount_max != null ? `< ${money(r.amount_max, { cents: false })}` : null;

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function RuleEditor({ rule, onClose }: { rule?: Rule; onClose: () => void }) {
  const toast = useToast();
  const { byId } = useCategories();
  const [field, setField] = useState<Rule['field']>(rule?.field || 'merchant');
  const [op, setOp] = useState<Rule['op']>(rule?.op || 'contains');
  const [pattern, setPattern] = useState(rule?.pattern || '');
  const [min, setMin] = useState(rule?.amount_min != null ? String(rule.amount_min) : '');
  const [max, setMax] = useState(rule?.amount_max != null ? String(rule.amount_max) : '');
  const [cat, setCat] = useState<number | null>(rule?.set_category_id ?? null);
  const [rename, setRename] = useState(rule?.set_display_name || '');
  const [review, setReview] = useState(rule?.mark_reviewed || false);
  const [applyNow, setApplyNow] = useState(true);
  const [picking, setPicking] = useState(false);
  const [amounts, setAmounts] = useState(rule?.amount_min != null || rule?.amount_max != null);
  const accounts = useAccounts();
  const goals = useGoals();
  const [account, setAccount] = useState<number | ''>(rule?.account_id ?? '');
  const [direction, setDirection] = useState<Rule['direction']>(rule?.direction || 'any');
  const [splits, setSplits] = useState<{ goal_id: number | ''; amount: string }[]>(rule?.goal_splits.map((x) => ({ goal_id: x.goal_id, amount: String(x.amount) })) || []);
  const [backfill, setBackfill] = useState(false);
  const [since, setSince] = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d.toISOString().slice(0, 10); });

  const cond = { field, op, pattern: pattern.trim(), amount_min: amounts && min ? Number(min) : null, amount_max: amounts && max ? Number(max) : null, account_id: account || null, direction };
  const goodSplits = splits.filter((x) => x.goal_id && Number(x.amount) > 0).map((x) => ({ goal_id: Number(x.goal_id), amount: Number(x.amount) }));
  const splitTotal = goodSplits.reduce((a, x) => a + x.amount, 0);
  const acctLabel = accounts.data?.find((a) => a.id === account)?.label;
  const dc = useDebounced(cond);
  const preview = useQuery({
    queryKey: ['rule-preview', dc],
    queryFn: () => api<{ count: number; locked: number; sample: Txn[]; typical_amount: number | null }>('/rules/preview', { body: dc }),
    enabled: !!dc.pattern || !!dc.account_id || dc.direction !== 'any',
    placeholderData: (p) => p,
  });
  const hasCondition = !!cond.pattern || !!cond.account_id || cond.direction !== 'any';
  const rangeOk = !(amounts && min && max && Number(min) > Number(max));
  const valid = hasCondition && rangeOk && (cat != null || !!rename.trim() || review || goodSplits.length > 0);
  const save = useMutate(async () => {
    const body = { ...cond, set_category_id: cat, set_display_name: rename.trim() || null, mark_reviewed: review, goal_splits: goodSplits };
    const r = rule ? await api<Rule>(`/rules/${rule.id}`, { method: 'PATCH', body: { ...body, set_display_name: rename } }) : await api<Rule>('/rules', { body });
    const doSplits = goodSplits.length > 0 && backfill;
    return applyNow || doSplits
      ? api<{ updated: number; allocated: number }>(`/rules/${r.id}/apply`, { body: doSplits ? { since } : {} })
      : { updated: 0, allocated: 0 };
  });

  if (picking) return <Sheet title="Set category to" size="lg" onClose={() => setPicking(false)}><CategoryPicker value={cat} onPick={(c) => { setCat(c.id); setPicking(false); }} /></Sheet>;
  const c = cat != null ? byId.get(cat) : null;
  const typical = preview.data?.typical_amount ?? null;

  const submit = () =>
    save.mutateAsync(undefined).then((r) => {
      const bits = [r.updated ? `${r.updated} transaction${r.updated === 1 ? '' : 's'} updated` : '', r.allocated ? `${r.allocated} goal allocation${r.allocated === 1 ? '' : 's'} made` : ''].filter(Boolean);
      toast(bits.length ? `Rule saved · ${bits.join(' · ')}` : 'Rule saved');
      onClose();
    }).catch((e) => toast(e.message, { kind: 'error' }));

  return (
    <Sheet
      size="lg"
      title={rule ? 'Edit rule' : 'New rule'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={submit}>{rule ? 'Save rule' : 'Create rule'}</Button>
        </>
      }
    >
      <div className="rule-editor">
        <div className="col">
          <h3>When</h3>
          <div className="form-grid">
            <Field label="Account">
              <Select value={account} onChange={(e) => setAccount(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Any account</option>
                {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.label}{a.mask ? ` ··${a.mask}` : ''}</option>)}
              </Select>
            </Field>
            <Field as="div" label="Direction">
              <Segmented value={direction} onChange={setDirection} options={[{ value: 'any', label: 'Any' }, { value: 'in', label: 'In' }, { value: 'out', label: 'Out' }]} />
            </Field>
            <Field as="div" label="Match on" full>
              <Segmented value={field} onChange={setField} options={[{ value: 'merchant', label: 'Merchant' }, { value: 'name', label: 'Bank description' }]} />
            </Field>
            <Field as="div" full label={field === 'merchant' ? 'Merchant' : 'Bank description'} hint={account || direction !== 'any' ? 'Optional when an account or direction is set' : undefined}>
              <Input
                value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={account || direction !== 'any' ? 'e.g. transfer' : 'e.g. amazon'}
                autoFocus={!rule && window.innerWidth > 760} aria-label="Text to match" spellCheck={false}
                lead={
                  <AddonSelect value={op} onChange={(e) => setOp(e.target.value as Rule['op'])} aria-label="How to match">
                    <option value="contains">contains</option>
                    <option value="equals">is exactly</option>
                    <option value="starts_with">starts with</option>
                  </AddonSelect>
                }
                onClear={() => setPattern('')}
              />
            </Field>
            <label className="check-row full">
              <Switch on={amounts} label="Limit by amount" onChange={setAmounts} />
              <span>Only for certain amounts</span>
            </label>
            {amounts && (
              <Field as="div" full label="Amount between" error={min && max && Number(min) > Number(max) ? 'The minimum is above the maximum.' : undefined}>
                <MoneyRange min={min} max={max} onMin={setMin} onMax={setMax} />
              </Field>
            )}
          </div>

          <h3>Then</h3>
          <div className="form-grid">
            <Field as="div" label="Set category">
              <PickerButton placeholder="Leave unchanged" onClick={() => setPicking(true)} onClear={() => setCat(null)} clearLabel="Clear category" aria-label="Set category">
                {c ? <CatLabel cat={c} /> : null}
              </PickerButton>
            </Field>
            <Field label="Rename to">
              <Input value={rename} onChange={(e) => setRename(e.target.value)} placeholder="Keep original name" />
            </Field>
            <label className="check-row full">
              <Switch on={review} label="Mark reviewed" onChange={setReview} />
              <span>Mark matching transactions as reviewed</span>
            </label>
          </div>

          <h3>Split deposits into goals</h3>
          <p className="field-hint" style={{ marginTop: -6 }}>
            Set aside part of each matching deposit, from the account it lands in. E.g. a $2,900 transfer to savings → $2,500 Down payment, $200 Travel.
          </p>
          {splits.map((sp, i) => (
            <div key={i} className="split-row">
              <Select value={sp.goal_id} onChange={(e) => setSplits(splits.map((x, j) => (j === i ? { ...x, goal_id: e.target.value ? Number(e.target.value) : '' } : x)))} aria-label="Goal">
                <option value="">Choose a goal…</option>
                {goals.data?.goals.filter((g) => !g.archived).map((g) => <option key={g.id} value={g.id}>{g.emoji} {g.name}</option>)}
              </Select>
              <MoneyInput value={sp.amount} placeholder="0" step={10} onChange={(v) => setSplits(splits.map((x, j) => (j === i ? { ...x, amount: v } : x)))} aria-label="Amount" />
              <IconButton size="sm" icon={<X />} label="Remove split" onClick={() => setSplits(splits.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div>
            <Button size="sm" icon={<Target />} onClick={() => setSplits([...splits, { goal_id: '', amount: '' }])}>Add a goal</Button>
          </div>
          {goodSplits.length > 0 && typical != null && (
            <div className={`split-meter ${splitTotal > typical + 0.5 ? 'over' : ''}`}>
              <div className="alloc-bar">
                {goodSplits.map((x, i) => {
                  const g = goals.data?.goals.find((q) => q.id === x.goal_id);
                  return <i key={i} style={{ width: `${Math.min(x.amount / Math.max(typical, splitTotal), 1) * 100}%`, background: g?.color || 'var(--accent)' }} />;
                })}
              </div>
              <span className="faint num small">
                {splitTotal > typical + 0.5
                  ? `More than the latest match (${money(typical, { cents: false })})`
                  : `${money(splitTotal, { cents: false })} of the latest ${money(typical, { cents: false })} match${typical - splitTotal >= 1 ? ` · ${money(typical - splitTotal, { cents: false })} left free` : ''}`}
              </span>
            </div>
          )}
          {goodSplits.length > 0 && !account && <p className="warn small">Pick the account the money lands in (e.g. savings) so only those deposits are split.</p>}
          {goodSplits.length > 0 && (
            <div className="form-grid">
              <label className="check-row full">
                <Switch on={backfill} label="Backfill" onChange={setBackfill} />
                <span>Also split deposits I've already received<span className="field-hint">Otherwise only new ones. Never counts the same deposit twice.</span></span>
              </label>
              {backfill && (
                <Field label="Since" full>
                  <DateInput value={since} max={todayIso()} onChange={setSince} aria-label="Since"
                    presets={[{ label: '30 days', value: isoFromToday({ days: -30 }) }, { label: '90 days', value: isoFromToday({ days: -90 }) }, { label: 'Start of year', value: `${todayIso().slice(0, 4)}-01-01` }]} />
                </Field>
              )}
            </div>
          )}

          {(c || rename.trim() || review) && (
            <label className="check-row">
              <Switch on={applyNow} label="Apply now" onChange={setApplyNow} />
              <span>Also update existing transactions<span className="field-hint">Re-categorise, rename or mark matching transactions you already have</span></span>
            </label>
          )}
        </div>

        <div className="col preview">
          <Panel title="Preview" meta={hasCondition && preview.data ? `${preview.data.count} match${preview.data.count === 1 ? '' : 'es'}` : undefined} flush>
            <div className="panel-body rule-sentence" style={{ borderBottom: '1px solid var(--border)' }}>
              <RuleSentence r={cond} account={acctLabel} />
              {goodSplits.length ? <>, set aside <b>{money(splitTotal, { cents: false })}</b> across {goodSplits.length} goal{goodSplits.length > 1 ? 's' : ''}</> : null}
              {c || rename.trim() || review ? (
                <>
                  , {[
                    c ? <span key="c">categorise as <b>{c.emoji} {c.name}</b></span> : null,
                    rename.trim() ? <span key="r">rename it <b>“{rename.trim()}”</b></span> : null,
                    review ? <span key="v">mark it reviewed</span> : null,
                  ].filter(Boolean).flatMap((x, i, a) => (i ? [i === a.length - 1 ? ' and ' : ', ', x] : [x]))}.
                </>
              ) : goodSplits.length ? '.' : <span className="faint"> → choose what happens</span>}
            </div>
            {!hasCondition ? (
              <div className="dt-empty">Pick an account, a direction, or type some text to see which transactions match.</div>
            ) : (
              <>
                <DataTable
                  sticky={false}
                  rows={preview.data?.sample || []}
                  loading={!preview.data}
                  skeletonRows={4}
                  rowKey={(t) => t.id}
                  empty={<div className="dt-empty">No transactions match yet.</div>}
                  columns={[
                    { key: 'd', header: 'Date', shrink: true, cell: (t) => <span className="muted num">{shortDate(t.date)}</span> },
                    { key: 'n', header: 'Transaction', wide: true, cell: (t) => <span className="ellipsis" style={{ display: 'block' }}>{prettyName(t.display_name || t.merchant_name || t.name)}</span> },
                    { key: 'a', header: 'Amount', num: true, cell: (t) => <span className={t.amount < 0 ? 'pos' : ''}>{txnAmount(t.amount)}</span> },
                  ]}
                />
                {preview.data && (preview.data.count > preview.data.sample.length || preview.data.locked > 0) && (
                  <div className="panel-foot">
                    <span>{preview.data.count > preview.data.sample.length ? `+${preview.data.count - preview.data.sample.length} more` : ''}</span>
                    {preview.data.locked > 0 && <span>{preview.data.locked} picked by hand stay as they are</span>}
                  </div>
                )}
              </>
            )}
          </Panel>
        </div>
      </div>
    </Sheet>
  );
}

type Filter = 'all' | 'category' | 'goals';

export default function Rules() {
  const toast = useToast();
  const rules = useRules();
  const { byId } = useCategories();
  const [edit, setEdit] = useState<{ rule?: Rule } | null>(null);
  const [confirm, setConfirm] = useState<Rule | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const goalsQ = useGoals();
  const apply = useMutate((r: Rule) => api<{ updated: number; allocated: number }>(`/rules/${r.id}/apply`, { body: r.goal_splits.length ? { since: new Date(Date.now() - 31 * 864e5).toISOString().slice(0, 10) } : {} }));
  const del = useMutate((id: number) => api(`/rules/${id}`, { method: 'DELETE' }));

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rules.data || []).filter((r) => {
      if (filter === 'category' && !r.set_category_id) return false;
      if (filter === 'goals' && !r.goal_splits.length) return false;
      if (!needle) return true;
      return [r.pattern, r.category_name, r.set_display_name, r.account_label].some((s) => s?.toLowerCase().includes(needle));
    });
  }, [rules.data, q, filter]);

  const run = (r: Rule) =>
    apply.mutateAsync(r).then((x) => toast([`Updated ${x.updated} transaction${x.updated === 1 ? '' : 's'}`, x.allocated ? `${x.allocated} goal allocations made` : ''].filter(Boolean).join(' · '))).catch((e) => toast(e.message, { kind: 'error' }));

  return (
    <>
      <SettingsHeader
        title="Rules"
        sub="Clean up new transactions and split deposits across goals. A category you pick by hand always wins."
        actions={<Button variant="primary" size="sm" icon={<Plus />} onClick={() => setEdit({})}>New rule</Button>}
        toolbar={
          (rules.data?.length || 0) > 0 && (
            <>
              <SearchInput value={q} onChange={setQ} placeholder="Search text, category, account" style={{ maxWidth: 320 }} sm />
              <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'category', label: 'Categorize' }, { value: 'goals', label: 'Goal splits' }]} />
              <span className="faint small num" style={{ marginLeft: 'auto' }}>{rows.length} of {rules.data?.length}</span>
            </>
          )
        }
      />

      <Panel flush className="clip">
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          loading={rules.isLoading}
          onRowClick={(r) => setEdit({ rule: r })}
          defaultSort={null}
          empty={
            rules.data?.length ? (
              <Empty compact title="No rules match" />
            ) : (
              <Empty icon={<Wand2 />} title="No rules yet" action={<Button variant="primary" size="sm" icon={<Plus />} onClick={() => setEdit({})}>Create a rule</Button>}>
                Rules rename and categorise transactions for you. When you recategorise a transaction, “Apply to all” creates one automatically.
              </Empty>
            )
          }
          columns={[
            {
              key: 'when', header: 'When', wide: true, className: 'wrap-col when-col',
              sort: (r) => r.pattern.toLowerCase(),
              cell: (r) => (
                <div className="cell">
                  {r.direction !== 'any' && <Badge tone={r.direction === 'in' ? 'good' : undefined}>{r.direction === 'in' ? 'Money in' : 'Money out'}</Badge>}
                  {r.account_label && <Badge tone="outline">{r.account_label}</Badge>}
                  {r.pattern && (
                    <span className="cond">
                      <span className="op">{r.field === 'merchant' ? 'merchant' : 'description'} {OPS[r.op]}</span>
                      <code title={r.pattern}>{r.pattern}</code>
                    </span>
                  )}
                  {amountRange(r) && <span className="cond"><span className="op">amount</span><span className="num">{amountRange(r)}</span></span>}
                </div>
              ),
              sub: (r) => (r.set_category_id ? `→ ${r.emoji || ''} ${r.category_name}` : r.goal_splits.length ? `→ ${r.goal_splits.length} goal split${r.goal_splits.length > 1 ? 's' : ''}` : r.set_display_name ? `→ rename “${r.set_display_name}”` : '→ mark reviewed'),
            },
            {
              key: 'then', header: 'Then', hide: 'sm', className: 'wrap-col',
              cell: (r) => (
                <div className="effects">
                  {r.set_category_id && <CatLabel cat={byId.get(r.set_category_id) || { emoji: r.emoji || '', color: r.color || '#8e8e93', name: r.category_name || '' }} />}
                  {r.set_display_name && <Badge title="Rename">“{r.set_display_name}”</Badge>}
                  {r.mark_reviewed && <Badge icon={<CheckCheck />}>Reviewed</Badge>}
                  {r.goal_splits.map((sp) => {
                    const g = goalsQ.data?.goals.find((x) => x.id === sp.goal_id);
                    return <Badge key={sp.goal_id} tone="accent" title={g?.name || 'Deleted goal'}>{g?.emoji} {g?.name || 'Deleted goal'} <span className="num">{money(sp.amount, { cents: false })}</span></Badge>;
                  })}
                </div>
              ),
            },
            { key: 'matches', header: 'Matches', num: true, sort: (r) => r.matches ?? 0, cell: (r) => r.matches ?? 0 },
            { key: 'alloc', header: 'Allocations', num: true, hide: 'md', sort: (r) => r.allocations_made ?? 0, cell: (r) => (r.allocations_made ? r.allocations_made : <span className="faint">—</span>) },
            { key: 'last', header: 'Last match', align: 'right', hide: 'lg', sort: (r) => r.last_match || '', cell: (r) => <span className="muted num">{r.last_match ? shortDate(r.last_match) : '—'}</span> },
            {
              key: 'act', shrink: true,
              cell: (r) => (
                <span className="row-actions">
                  <IconButton size="sm" icon={<Play />} label={r.goal_splits.length ? 'Run on the last 31 days (never double-counts)' : 'Run on existing transactions'} onClick={() => run(r)} />
                  <IconButton size="sm" icon={<Pencil />} label="Edit" onClick={() => setEdit({ rule: r })} />
                  <IconButton size="sm" icon={<Trash2 />} label="Delete" className="danger" onClick={() => setConfirm(r)} />
                </span>
              ),
            },
          ]}
        />
      </Panel>

      {edit && <RuleEditor rule={edit.rule} onClose={() => setEdit(null)} />}
      {confirm && (
        <Modal onClose={() => setConfirm(null)}>
          <h2>Delete this rule?</h2>
          <p className="muted" style={{ marginTop: 6 }}>
            <RuleSentence r={confirm} account={confirm.account_label} />.
          </p>
          <p className="faint small" style={{ marginTop: 8 }}>Transactions it already changed keep their category and name, and money it set aside for goals stays there. New transactions won't be touched.</p>
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="danger" className="solid" onClick={() => del.mutateAsync(confirm.id).then(() => { toast('Rule deleted'); setConfirm(null); })}>Delete rule</Button>
          </div>
        </Modal>
      )}
    </>
  );
}
