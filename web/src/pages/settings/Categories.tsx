import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Archive, ChevronRight, Plus, RefreshCw, Trash2, Wand2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useCategories, useMutate } from '../../lib/queries';
import { money, shortDate } from '../../lib/format';
import type { Category } from '../../lib/types';
import { Badge, Button, CatAvatar, CatLabel, DataTable, EmojiPicker, Empty, Field, Input, Panel, SearchInput, Select, Sheet, SwatchPicker, Switch, useToast, type TableGroup } from '../../components/ui';
import { SettingsHeader } from './SettingsLayout';

const EMOJIS = ['🛒', '🍽️', '☕', '🍸', '🍕', '🌮', '🍷', '🏠', '💡', '📶', '🪴', '🧹', '🔧', '⛽', '🚕', '🚇', '🅿️', '🚲', '✈️', '🧳', '🏖️', '🛍️', '👕', '💻', '📚', '🎬', '📺', '🎮', '🎵', '⚽', '🎁', '🐾', '👶', '🎓', '💪', '🩺', '🏥', '💇', '💍', '🎨', '🛡️', '🧾', '🏛️', '🧰', '🏷️', '💰', '📈', '💵'];
const COLORS = ['#ff453a', '#ff9f0a', '#ffd60a', '#34c759', '#30d158', '#66d4cf', '#40c8e0', '#0a84ff', '#5e5ce6', '#7d7aff', '#bf5af2', '#ff375f', '#ac8e68', '#8e8e93'];

export function CategoryEditor({ cat, groupId, onClose }: { cat?: Category; groupId?: number; onClose: () => void }) {
  const toast = useToast();
  const { data } = useCategories();
  const [name, setName] = useState(cat?.name || '');
  const [emoji, setEmoji] = useState(cat?.emoji || '🏷️');
  const [color, setColor] = useState(cat?.color || '#7d7aff');
  const [group, setGroup] = useState(cat?.group_id || groupId || data?.groups[0]?.id);
  const [rollover, setRollover] = useState(cat?.rollover || false);
  const g = data?.groups.find((x) => x.id === group);
  const save = useMutate(() =>
    cat
      ? api(`/categories/${cat.id}`, { method: 'PATCH', body: { name, emoji, color, group_id: group, ...(rollover !== cat.rollover ? { rollover } : {}) } })
      : api('/categories', { body: { name, emoji, color, group_id: group } }),
  );
  const archive = useMutate(() => (cat?.key ? api(`/categories/${cat.id}`, { method: 'PATCH', body: { archived: !cat.archived } }) : api(`/categories/${cat!.id}`, { method: 'DELETE' })));
  const changed = !cat || name !== cat.name || emoji !== cat.emoji || color !== cat.color || group !== cat.group_id || rollover !== cat.rollover;

  return (
    <Sheet
      title={cat ? 'Edit category' : 'New category'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || !changed} loading={save.isPending}
            onClick={() => save.mutateAsync(undefined).then(() => { toast(cat ? 'Category updated' : `${name} created`); onClose(); }).catch((e) => toast(e.message, { kind: 'error' }))}>
            {cat ? 'Save changes' : 'Create category'}
          </Button>
        </>
      }
    >
      <div className="cat-preview">
        <CatAvatar cat={{ emoji, color }} size="xl" />
        <div className="grow">
          <div className="n ellipsis">{name || 'New category'}</div>
          <div className="faint small num">
            {cat ? <>{cat.tx_count} transactions{cat.avg3 ? ` · avg ${money(cat.avg3, { cents: false })}/mo` : ''}{cat.last_used ? ` · last used ${shortDate(cat.last_used)}` : ''}</> : g?.name}
          </div>
        </div>
      </div>
      <div className="stack">
        <div className="form-grid">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kids" autoFocus={!cat && window.innerWidth > 760} /></Field>
          <Field label="Group">
            <Select value={group} onChange={(e) => setGroup(Number(e.target.value))}>
              {data?.groups.map((x) => <option key={x.id} value={x.id}>{x.name}{x.kind === 'income' ? ' (income)' : x.kind === 'transfer' ? ' (not spending)' : ''}</option>)}
            </Select>
          </Field>
        </div>
        <div className="field"><span className="field-label">Icon</span>
          <EmojiPicker value={emoji} options={EMOJIS} onChange={setEmoji} />
        </div>
        <div className="field"><span className="field-label">Colour</span>
          <SwatchPicker value={color} options={COLORS} onChange={setColor} />
        </div>
        {cat && g?.kind === 'expense' && (
          <div className="kv">
            <label>
              <RefreshCw size={14} className="faint" />
              <span className="grow">
                Roll over unspent budget
                <span className="field-hint" style={{ display: 'block' }}>Leftovers carry into next month; overspending reduces it</span>
              </span>
              <Switch on={rollover} label="Rollover" onChange={setRollover} />
            </label>
            <Link to="/budgets" viewTransition onClick={onClose}>
              <span className="grow">Set this category's budget</span>
              <ChevronRight size={14} className="faint" />
            </Link>
            {!!cat.rule_count && (
              <Link to="/settings/rules" viewTransition onClick={onClose}>
                <Wand2 size={14} className="faint" />
                <span className="grow">{cat.rule_count} rule{cat.rule_count > 1 ? 's' : ''} use this category</span>
                <ChevronRight size={14} className="faint" />
              </Link>
            )}
          </div>
        )}
        {cat && (
          <div className="danger-zone">
            <div className="grow">
              <div className="strong">{cat.key ? (cat.archived ? 'Restore category' : 'Archive category') : 'Delete category'}</div>
              <div className="faint small">
                {cat.key ? (cat.archived ? 'Show it in pickers and budgets again.' : 'Hide it from pickers and budgets. Past transactions keep it.') : `Its ${cat.tx_count} transactions move to Other.`}
              </div>
            </div>
            <Button size="sm" variant="danger" icon={cat.key ? <Archive /> : <Trash2 />}
              onClick={() => archive.mutateAsync(undefined).then(() => { toast(cat.key ? (cat.archived ? 'Restored' : 'Archived') : 'Deleted'); onClose(); }).catch((e) => toast(e.message, { kind: 'error' }))}>
              {cat.key ? (cat.archived ? 'Restore' : 'Archive') : 'Delete'}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

export default function Categories() {
  const { data, isLoading } = useCategories();
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [edit, setEdit] = useState<{ cat?: Category; group?: number } | null>(null);
  const archivedCount = (data?.categories || []).filter((c) => c.archived).length;
  const kindOf = useMemo(() => new Map((data?.groups || []).map((g) => [g.id, g.kind])), [data]);
  const groups: TableGroup<Category>[] = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.groups || [])
      .map((g) => {
        const rows = (data?.categories || []).filter((c) => c.group_id === g.id && (showArchived || !c.archived) && (!needle || c.name.toLowerCase().includes(needle)));
        const n = rows.reduce((a, c) => a + c.tx_count, 0);
        return {
          key: g.id,
          rows,
          label: (
            <span className="row" style={{ gap: 8 }}>
              {g.name}
              {g.kind !== 'expense' && <Badge>{g.kind === 'income' ? 'Income' : 'Not counted as spending'}</Badge>}
              <span className="faint num">{rows.length} · {n} txns</span>
            </span>
          ),
          right: <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setEdit({ group: g.id })} aria-label={`Add to ${g.name}`}>Add</Button>,
        };
      })
      .filter((g) => g.rows.length || !needle);
  }, [data, q, showArchived]);

  return (
    <>
      <SettingsHeader
        title="Categories"
        sub="How spending is grouped everywhere: budgets, cash flow and reports."
        actions={<Button variant="primary" size="sm" icon={<Plus />} onClick={() => setEdit({})}>New category</Button>}
        toolbar={
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Find a category" style={{ maxWidth: 320 }} sm />
            {archivedCount > 0 && (
              <button className={`chip ${showArchived ? 'on' : ''}`} onClick={() => setShowArchived(!showArchived)}>Show archived ({archivedCount})</button>
            )}
          </>
        }
      />
      <Panel flush className="clip">
        <DataTable
          groups={groups}
          rowKey={(c) => c.id}
          loading={isLoading}
          skeletonRows={12}
          onRowClick={(c) => setEdit({ cat: c })}
          rowClass={(c) => c.archived && 'dim'}
          empty={<Empty compact title="No categories match" />}
          columns={[
            {
              key: 'name', header: 'Category', wide: true, sort: (c) => c.name.toLowerCase(),
              cell: (c) => (
                <div className="cell">
                  <CatLabel cat={c} />
                  {c.archived && <Badge>Archived</Badge>}
                </div>
              ),
              sub: (c) => `${c.tx_count ? `${c.tx_count} transactions` : 'Not used yet'}${c.avg3 && kindOf.get(c.group_id) === 'expense' ? ` · ${money(c.avg3, { cents: false })}/mo` : ''}`,
            },
            { key: 'n', header: 'Transactions', num: true, hide: 'sm', sort: (c) => c.tx_count, cell: (c) => (c.tx_count ? c.tx_count : <span className="faint">—</span>) },
            { key: 'avg', header: 'Avg / month', num: true, hide: 'sm', sort: (c) => c.avg3 ?? 0, cell: (c) => (c.avg3 && kindOf.get(c.group_id) === 'expense' ? money(c.avg3, { cents: false }) : <span className="faint">—</span>) },
            { key: 'last', header: 'Last used', align: 'right', hide: 'md', sort: (c) => c.last_used || '', cell: (c) => <span className="muted num">{c.last_used ? shortDate(c.last_used) : '—'}</span> },
            { key: 'rules', header: 'Rules', num: true, hide: 'md', sort: (c) => c.rule_count ?? 0, cell: (c) => (c.rule_count ? c.rule_count : <span className="faint">—</span>) },
            { key: 'roll', header: 'Rollover', align: 'center', hide: 'lg', cell: (c) => (c.rollover ? <Badge tone="accent" icon={<RefreshCw />}>On</Badge> : null) },
          ]}
        />
      </Panel>
      {edit && <CategoryEditor cat={edit.cat} groupId={edit.group} onClose={() => setEdit(null)} />}
    </>
  );
}
