// Tally UI kit. Every page is composed from these so spacing, density, type and behaviour stay identical
// across screens. Styling lives in styles/app.css; pages only arrange kit pieces.
//
//   Page, PageHeader ......... page frame: one sticky title line (+ optional sticky toolbar row)
//   Panel .................... bordered surface with a 40px head (title · meta · actions), body, foot
//   StatGrid, Stat ........... a single strip of figures with hairline dividers
//   DataTable ................ sortable, groupable, keyboard-navigable table with sticky header,
//                              responsive column hiding and an optional selection column
//   Button, IconButton, ButtonLink, Segmented, Switch
//   Field, FormRow + the input variants listed under "form controls" below
//   Badge, CatLabel, CatPill, Meter/Bar, Ring, Sparkline, Money, Delta, Empty, Skel
//   Sheet (drawer / bottom sheet), Modal, toasts
import {
  createContext, forwardRef, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type Key, type KeyboardEvent as RKeyboardEvent, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router';
import { AlertTriangle, ArrowDown, ArrowDownRight, ArrowUp, ArrowUpRight, Calendar, Check, ChevronDown, ChevronLeft, ChevronRight, Pencil, Plus, Search, X } from 'lucide-react';
import { money, monthLabel, relDate, shiftMonth, thisMonth } from '../lib/format';
import type { Category } from '../lib/types';

const vars = (o: Record<string, string | number | undefined>) => o as CSSProperties;
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---- breakpoints --------------------------------------------------------------
// Same numbers as app.css. Columns hide in JS (not CSS) so group rows can span the visible columns.

// xl is for tables that share the row with a side rail: they run out of room well before the viewport does.
export type Breakpoint = 'sm' | 'md' | 'lg' | 'xl';
const BP: Record<Breakpoint, number> = { sm: 760, md: 1024, lg: 1180, xl: 1600 };
function subscribeResize(cb: () => void) {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}
export function useBelow(bp: Breakpoint) {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth <= BP[bp], () => false);
}
export const useIsPhone = () => useBelow('sm');
/** Wide enough to dock a detail panel beside a table instead of opening a drawer. */
export const useWide = (px = 1400) => useSyncExternalStore(subscribeResize, () => window.innerWidth >= px, () => false);

// ---- page frame ---------------------------------------------------------------

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('page', className)}>{children}</div>;
}

// One sticky line: title (+ dim subtitle), context controls, actions on the right.
// `toolbar` renders a second sticky row underneath for filters and search.
// Pages that live under the phone tab bar's More tab; there they get a back button to it.
const UNDER_MORE = /^\/(accounts|recurring|insights|settings)\/?$/;

export function PageHeader({ title, sub, context, actions, toolbar, back: backTo }: { title: ReactNode; sub?: ReactNode; context?: ReactNode; actions?: ReactNode; toolbar?: ReactNode; back?: string }) {
  const nav = useNavigate();
  const phone = useIsPhone();
  const { pathname } = useLocation();
  const back = backTo || (phone && UNDER_MORE.test(pathname) ? '/more' : undefined);
  return (
    <>
      <header className="page-header">
        {back && (
          <button className="btn ghost icon-btn sm back" aria-label="Back" onClick={() => nav(back, { viewTransition: true })}>
            <ChevronLeft />
          </button>
        )}
        <div className="title">
          <h1>{title}</h1>
          {sub && <span className="sub">{sub}</span>}
        </div>
        {context && <div className="context">{context}</div>}
        {actions && <div className="page-actions">{actions}</div>}
      </header>
      {toolbar && <div className="page-toolbar">{toolbar}</div>}
    </>
  );
}

// ---- panel --------------------------------------------------------------------

export function Panel({ title, meta, actions, children, foot, flush = false, className, style, id, bodyClassName }: {
  title?: ReactNode; meta?: ReactNode; actions?: ReactNode; children?: ReactNode; foot?: ReactNode; flush?: boolean;
  className?: string; style?: CSSProperties; id?: string; bodyClassName?: string;
}) {
  return (
    <section className={cx('panel', className)} style={style} id={id}>
      {(title || actions || meta) && (
        <div className="panel-head">
          {title && <h2 className="title">{title}</h2>}
          {meta && <span className="meta">{meta}</span>}
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {flush ? children : <div className={cx('panel-body', bodyClassName)}>{children}</div>}
      {foot && <div className="panel-foot">{foot}</div>}
    </section>
  );
}

// Small text link that sits in a panel head ("All", "Details").
export function PanelLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link viewTransition to={to} className="card-link">
      {children}
      <ChevronRight />
    </Link>
  );
}

// ---- stats --------------------------------------------------------------------

export function StatGrid({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <div className={cx('stat-grid', className)} style={style}>{children}</div>;
}

export function Stat({ label, value, sub, tone, to, onClick, large, title }: {
  label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'bad'; to?: string; onClick?: () => void; large?: boolean; title?: string;
}) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className={cx('stat-value num', large && 'lg')}>{value}</span>
      {sub != null && sub !== false && <span className="stat-sub">{sub}</span>}
    </>
  );
  const cls = cx('stat', tone);
  if (to) return <Link viewTransition to={to} className={cls} title={title}>{body}</Link>;
  if (onClick) return <button type="button" className={cls} onClick={onClick} title={title}>{body}</button>;
  return <div className={cls} title={title}>{body}</div>;
}

// ---- data table ---------------------------------------------------------------

export type Column<T> = {
  key: string;
  header?: ReactNode;
  cell: (row: T) => ReactNode;
  /** Second line shown under the cell on phones only (where other columns are hidden). */
  sub?: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Right-aligned tabular figures. */
  num?: boolean;
  /** Takes the leftover width and ellipsizes. Give exactly one column this. */
  wide?: boolean;
  /** As narrow as its content. */
  shrink?: boolean;
  width?: number | string;
  /** Floor so a `wide` column can't collapse when the others are greedy. */
  minWidth?: number;
  /** Hidden at and below this breakpoint. */
  hide?: Breakpoint;
  /** Enables sorting by this value. */
  sort?: (row: T) => number | string | null | undefined;
  footer?: ReactNode;
  className?: string;
  title?: string;
};

export type TableGroup<T> = {
  key: Key;
  label: ReactNode;
  rows: T[];
  /** Per-column summary cells for the group row (aligned with the columns). Falls back to `right`. */
  cells?: Partial<Record<string, ReactNode>>;
  right?: ReactNode;
};

type SortState = { key: string; dir: 1 | -1 } | null;

export function DataTable<T>({
  columns, rows, groups, rowKey, onRowClick, selected, rowClass, empty, loading, skeletonRows = 8,
  footer, defaultSort, className, sticky = true, select, onKeyAction,
}: {
  columns: Column<T>[];
  rows?: T[];
  groups?: TableGroup<T>[];
  rowKey: (row: T) => Key;
  onRowClick?: (row: T) => void;
  selected?: Key | null;
  rowClass?: (row: T) => string | false | undefined;
  empty?: ReactNode;
  loading?: boolean;
  skeletonRows?: number;
  footer?: boolean;
  defaultSort?: SortState;
  className?: string;
  sticky?: boolean;
  /** Checkbox column for bulk actions. */
  select?: { selected: Set<Key>; onChange: (next: Set<Key>) => void };
  /** Extra single-key shortcuts on the focused row, e.g. { r: markReviewed }. */
  onKeyAction?: Record<string, (row: T) => void>;
}) {
  const sm = useBelow('sm'), md = useBelow('md'), lg = useBelow('lg'), xl = useBelow('xl');
  const hidden = (b?: Breakpoint) => (b === 'sm' && sm) || (b === 'md' && md) || (b === 'lg' && lg) || (b === 'xl' && xl);
  const cols = columns.filter((c) => !hidden(c.hide));
  const [sort, setSort] = useState<SortState>(defaultSort ?? null);
  if (sm) select = undefined; // no checkbox column on phones

  const sorter = useMemo(() => {
    const col = sort && columns.find((c) => c.key === sort.key);
    if (!col?.sort || !sort) return null;
    const get = col.sort;
    return (a: T, b: T) => {
      const x = get(a), y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    };
  }, [sort, columns]);

  const sections: TableGroup<T>[] = useMemo(() => {
    const base = groups ?? [{ key: '__all', label: null, rows: rows ?? [] }];
    return sorter ? base.map((g) => ({ ...g, rows: [...g.rows].sort(sorter) })) : base;
  }, [groups, rows, sorter]);
  const total = sections.reduce((n, g) => n + g.rows.length, 0);
  const allKeys = useMemo(() => sections.flatMap((g) => g.rows.map(rowKey)), [sections, rowKey]);

  const clickSort = (c: Column<T>) => {
    if (!c.sort) return;
    setSort((s) => (s?.key !== c.key ? { key: c.key, dir: c.num ? -1 : 1 } : s.dir === (c.num ? -1 : 1) ? { key: c.key, dir: (c.num ? 1 : -1) as 1 | -1 } : null));
  };

  const onRowKey = (e: RKeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (e.target !== e.currentTarget) return;
    const tr = e.currentTarget;
    const move = (dir: 1 | -1) => {
      let n: Element | null = tr;
      do {
        n = dir === 1 ? n.nextElementSibling ?? n.parentElement?.nextElementSibling?.firstElementChild ?? null : n.previousElementSibling ?? n.parentElement?.previousElementSibling?.lastElementChild ?? null;
      } while (n && !(n as HTMLElement).classList.contains('clickable'));
      if (n) {
        e.preventDefault();
        (n as HTMLElement).focus();
        (n as HTMLElement).scrollIntoView({ block: 'nearest' });
      }
    };
    if (e.key === 'ArrowDown' || e.key === 'j') move(1);
    else if (e.key === 'ArrowUp' || e.key === 'k') move(-1);
    else if ((e.key === 'Enter' || e.key === ' ') && onRowClick) {
      e.preventDefault();
      onRowClick(row);
    } else if (onKeyAction?.[e.key] && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      onKeyAction[e.key](row);
    }
  };

  const toggle = (k: Key) => {
    if (!select) return;
    const n = new Set(select.selected);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    select.onChange(n);
  };
  const allOn = !!select && allKeys.length > 0 && allKeys.every((k) => select.selected.has(k));
  const span = cols.length + (select ? 1 : 0);

  const tdClass = (c: Column<T>) => cx(c.num && 'r num', c.align === 'right' && 'r', c.align === 'center' && 'c', c.wide && 'wide', c.shrink && 'shrink', c.className);

  return (
    <div className="dt-wrap">
      <table className={cx('dt', !sticky && 'static', className)}>
        <thead>
          <tr>
            {select && (
              <th className="shrink">
                <input type="checkbox" className="checkbox" aria-label="Select all" checked={allOn} onChange={() => select.onChange(allOn ? new Set() : new Set(allKeys))} />
              </th>
            )}
            {cols.map((c) => (
              <th
                key={c.key} className={cx(tdClass(c), c.sort && 'sortable')} style={c.width != null || c.minWidth != null ? { width: c.width, minWidth: c.minWidth } : undefined}
                onClick={() => clickSort(c)} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined} title={c.title}
              >
                {c.header}
                {sort?.key === c.key && <span className="sort">{sort.dir === 1 ? <ArrowUp /> : <ArrowDown />}</span>}
              </th>
            ))}
          </tr>
        </thead>
        {loading ? (
          <tbody>
            {Array.from({ length: skeletonRows }, (_, i) => (
              <tr key={i}>
                {select && <td />}
                {cols.map((c, j) => (
                  <td key={c.key} className={tdClass(c)}>
                    <Skel w={c.num ? 56 : j === 0 ? `${50 + ((i * 17) % 40)}%` : 72} h={10} style={c.num ? { marginLeft: 'auto' } : undefined} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ) : total === 0 ? (
          <tbody>
            <tr>
              <td colSpan={span} style={{ height: 'auto', padding: 0 }}>{empty ?? <div className="dt-empty">Nothing here</div>}</td>
            </tr>
          </tbody>
        ) : (
          sections.map((g) => (
            <tbody key={g.key}>
              {g.label != null && (
                <tr className="group">
                  {g.cells ? (
                    <>
                      {select && <td />}
                      {cols.map((c, i) => <td key={c.key} className={tdClass(c)}>{i === 0 ? g.label : g.cells?.[c.key]}</td>)}
                    </>
                  ) : (
                    <>
                      {g.right != null && span === 1 ? (
                        // Only one visible column (phones): a separate cell would add a column the rows leave empty.
                        <td><div className="group-line">{g.label}<span className="num">{g.right}</span></div></td>
                      ) : (
                        <>
                          <td colSpan={Math.max(1, span - (g.right != null ? 1 : 0))}>{g.label}</td>
                          {g.right != null && <td className="r num">{g.right}</td>}
                        </>
                      )}
                    </>
                  )}
                </tr>
              )}
              {g.rows.map((r) => {
                const k = rowKey(r);
                return (
                  <tr
                    key={k}
                    className={cx(onRowClick && 'clickable', selected === k && 'selected', select?.selected.has(k) && 'selected', rowClass?.(r))}
                    onClick={onRowClick ? (e) => { if (!(e.target as HTMLElement).closest('button, a, input, select, label')) onRowClick(r); } : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onKeyDown={onRowClick || onKeyAction ? (e) => onRowKey(e, r) : undefined}
                  >
                    {select && (
                      <td className="shrink">
                        <input type="checkbox" className="checkbox" aria-label="Select row" checked={select.selected.has(k)} onChange={() => toggle(k)} />
                      </td>
                    )}
                    {cols.map((c) => (
                      <td key={c.key} className={tdClass(c)} style={c.width != null ? { width: c.width } : undefined}>
                        {c.sub && sm ? (
                          <>
                            {c.cell(r)}
                            <span className="dt-sub">{c.sub(r)}</span>
                          </>
                        ) : c.cell(r)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          ))
        )}
        {footer && !loading && total > 0 && (
          <tfoot>
            <tr>
              {select && <td />}
              {cols.map((c) => <td key={c.key} className={tdClass(c)}>{c.footer}</td>)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// ---- buttons ------------------------------------------------------------------

type Variant = 'default' | 'primary' | 'ghost' | 'subtle' | 'danger';
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode; block?: boolean; active?: boolean; loading?: boolean };
const btnClass = (variant: Variant = 'default', size: 'sm' | 'md' | 'lg' = 'md', extra?: string | false) =>
  cx('btn', variant !== 'default' && variant, size !== 'md' && size, extra);

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant, size, icon, block, active, loading, className, children, type = 'button', disabled, ...rest }, ref) {
  return (
    <button ref={ref} type={type} className={cx(btnClass(variant, size), block && 'block', active && 'active', className)} disabled={disabled || loading} {...rest}>
      {icon}
      {children}
    </button>
  );
});

export function IconButton({ icon, label, variant = 'ghost', size = 'md', className, ...rest }: Omit<ButtonProps, 'children'> & { icon: ReactNode; label: string }) {
  return <Button variant={variant} size={size} className={cx('icon-btn', className)} aria-label={label} title={label} {...rest}>{icon}</Button>;
}

export function ButtonLink({ to, href, variant, size, icon, children, className, title, download }: { to?: string; href?: string; variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode; children?: ReactNode; className?: string; title?: string; download?: boolean }) {
  const cls = cx(btnClass(variant, size), !children && 'icon-btn', className);
  if (href) return <a className={cls} href={href} title={title} aria-label={title} download={download}>{icon}{children}</a>;
  return <Link viewTransition className={cls} to={to || '/'} title={title} aria-label={!children ? title : undefined}>{icon}{children}</Link>;
}

// ---- form controls ------------------------------------------------------------
//
// Every text-like control sits in one shell, `.ig`: the box carries the border, hover, focus ring, size and
// invalid state, and the <input> inside is borderless. Icons, units, attached selects and clear buttons therefore
// line up the same way everywhere. Pick the variant that matches what's being entered:
//
//   Input ........... free text; `lead`/`trail` adornments (icon, unit, AddonSelect), `invalid`
//   MoneyInput ...... dollar amounts: digits only, grouped (5,000) when not editing, ↑/↓ step (⇧ ×10), `suffix`
//                     ("/mo"), `sm`/`lg`, variant "inline" for a figure edited in place in a table cell
//   MoneyRange ...... a min–max pair in one control (rule amount limits); min > max shows as invalid
//   PercentInput .... 0–100 with a % suffix; out of range shows as invalid
//   SearchInput ..... icon, clear button, Esc clears before it closes anything
//   DateInput ....... calendar icon, click opens the picker, relative hint ("In 8 months"), `presets`, `clearable`
//   InlineEdit ...... a heading that is also an input (names in detail sheets): Enter saves, Esc reverts
//   Select .......... native select, token-coloured chevron; variant "filter" (toolbar: highlights when set,
//                     `onClear`), variant "add" (dashed "+ Link an account…" action)
//   PickerButton .... select-looking trigger for a choice made in a sheet (category picker)
//   EmojiPicker, SwatchPicker ... icon and colour choosers

// as="div" for controls that aren't a single input (Segmented, button groups), so clicking the label does nothing.
export function Field({ label, hint, error, children, className, full, as = 'label' }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string; full?: boolean; as?: 'label' | 'div' }) {
  const El = as;
  return (
    <El className={cx('field', full && 'full', className)} role={as === 'div' && typeof label === 'string' ? 'group' : undefined} aria-label={as === 'div' && typeof label === 'string' ? label : undefined}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </El>
  );
}

// Settings-style row: label + hint on the left, control on the right (stacks on narrow screens).
export function FormRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="form-row">
      <div className="label">
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </div>
      <div className="stack tight">{children}</div>
    </div>
  );
}

type ShellProps = { sm?: boolean; lg?: boolean; invalid?: boolean; disabled?: boolean; className?: string; style?: CSSProperties; children: ReactNode };

// The bordered box. A click on its padding or an adornment focuses the input, like a click on the field itself.
function Shell({ sm, lg, invalid, disabled, className, style, children }: ShellProps) {
  return (
    <div
      className={cx('ig', sm && 'sm', lg && 'lg', invalid && 'invalid', disabled && 'disabled', className)} style={style}
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest('input, select, button')) return;
        const input = e.currentTarget.querySelector('input');
        if (input) { e.preventDefault(); input.focus(); }
      }}
    >
      {children}
    </div>
  );
}

const ClearButton = ({ onClick, label = 'Clear' }: { onClick: () => void; label?: string }) => (
  <button type="button" className="ig-clear" aria-label={label} title={label} onClick={onClick}><X /></button>
);

type InputProps = InputHTMLAttributes<HTMLInputElement> & { sm?: boolean; invalid?: boolean; lead?: ReactNode; trail?: ReactNode; onClear?: () => void };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, sm, invalid, lead, trail, onClear, style, ...rest }, ref) {
  if (lead == null && trail == null && !onClear) return <input ref={ref} className={cx('input', sm && 'sm', className)} style={style} aria-invalid={invalid || undefined} {...rest} />;
  return (
    <Shell sm={sm} invalid={invalid} disabled={rest.disabled} className={className} style={style}>
      {lead != null && <span className="addon">{lead}</span>}
      <input ref={ref} aria-invalid={invalid || undefined} {...rest} />
      {onClear && rest.value != null && rest.value !== '' && <ClearButton onClick={onClear} />}
      {trail != null && <span className="addon">{trail}</span>}
    </Shell>
  );
});

// A compact select fused to the front of an Input, e.g. [contains ▾ | amazon].
export function AddonSelect({ children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="ig-select">
      <select {...rest}>{children}</select>
      <ChevronDown aria-hidden />
    </span>
  );
}

export function Textarea({ className, invalid, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea className={cx('textarea', className)} aria-invalid={invalid || undefined} {...rest} />;
}

// -- amounts --

// Digits and one decimal point, at most `decimals` places. Pasting "$1,234.56" gives "1234.56".
const cleanAmount = (s: string, decimals = 2) => {
  let v = s.replace(/[^0-9.]/g, '');
  const i = v.indexOf('.');
  if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '').slice(0, decimals);
  return v;
};
const groupAmount = (s: string) => {
  if (!s) return s;
  const [i, f] = s.split('.');
  return (i || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f != null ? `.${f}` : '');
};

type AmountProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'step' | 'max'> & {
  value: string; onChange: (v: string) => void; step?: number; max?: number; selectOnFocus?: boolean;
};

// The bare <input> shared by MoneyInput, MoneyRange and PercentInput. The value stays a plain "1234.5" string;
// grouping is display-only and drops away while the field has focus so the caret never jumps.
const AmountField = forwardRef<HTMLInputElement, AmountProps>(function AmountField({ value, onChange, step = 1, max, selectOnFocus, onFocus, onBlur, onKeyDown, ...rest }, ref) {
  const [editing, setEditing] = useState(false);
  return (
    <input
      ref={ref} inputMode="decimal" autoComplete="off" spellCheck={false}
      value={editing ? value : groupAmount(value)}
      onChange={(e) => onChange(cleanAmount(e.target.value))}
      onFocus={(e) => {
        setEditing(true);
        onFocus?.(e);
        if (selectOnFocus) { const el = e.currentTarget; requestAnimationFrame(() => el.select()); }
      }}
      onBlur={(e) => { setEditing(false); onBlur?.(e); }}
      onKeyDown={(e) => {
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          const by = step * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
          let n = Math.max(0, Math.round(((Number(value) || 0) + by) * 100) / 100);
          if (max != null) n = Math.min(n, max);
          onChange(String(n));
        }
        onKeyDown?.(e);
      }}
      {...rest}
    />
  );
});

type MoneyInputProps = AmountProps & { sm?: boolean; lg?: boolean; invalid?: boolean; suffix?: ReactNode; variant?: 'inline'; style?: CSSProperties };

export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput({ sm, lg, invalid, suffix, variant, className, style, ...rest }, ref) {
  return (
    <Shell sm={sm} lg={lg} invalid={invalid} disabled={rest.disabled} className={cx('amount', variant, className)} style={style}>
      <span className="addon cur">$</span>
      <AmountField ref={ref} aria-invalid={invalid || undefined} {...rest} />
      {suffix && <span className="addon unit">{suffix}</span>}
    </Shell>
  );
});

export function MoneyRange({ min, max, onMin, onMax, sm, placeholder = 'Any' }: { min: string; max: string; onMin: (v: string) => void; onMax: (v: string) => void; sm?: boolean; placeholder?: string }) {
  const bad = min !== '' && max !== '' && Number(min) > Number(max);
  return (
    <Shell sm={sm} invalid={bad} className="amount range">
      <span className="addon cur">$</span>
      <AmountField value={min} onChange={onMin} placeholder={placeholder} aria-label="Minimum amount" aria-invalid={bad || undefined} />
      <span className="addon sep">to</span>
      <span className="addon cur">$</span>
      <AmountField value={max} onChange={onMax} placeholder={placeholder} aria-label="Maximum amount" aria-invalid={bad || undefined} />
    </Shell>
  );
}

export function PercentInput({ sm, invalid, className, style, ...rest }: AmountProps & { sm?: boolean; invalid?: boolean; style?: CSSProperties }) {
  const n = Number(rest.value);
  const bad = invalid ?? (rest.value !== '' && !(n > 0 && n <= 100));
  return (
    <Shell sm={sm} invalid={bad} disabled={rest.disabled} className={cx('amount', className)} style={style}>
      <AmountField max={100} aria-invalid={bad || undefined} {...rest} />
      <span className="addon unit">%</span>
    </Shell>
  );
}

// -- search & dates --

export function SearchInput({ value, onChange, placeholder = 'Search', autoFocus, className, style, sm, 'aria-label': ariaLabel }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; className?: string; style?: CSSProperties; sm?: boolean; 'aria-label'?: string }) {
  return (
    <Shell sm={sm} className={cx('search', className)} style={style}>
      <span className="addon"><Search /></span>
      <input
        role="searchbox" enterKeyHint="search" autoComplete="off" spellCheck={false}
        placeholder={placeholder} aria-label={ariaLabel ?? placeholder} value={value} autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // First Esc clears; only an empty field lets Esc through to close the sheet or palette.
          if (e.key === 'Escape' && value) { e.preventDefault(); e.stopPropagation(); onChange(''); }
        }}
      />
      {value && <ClearButton label="Clear search" onClick={() => onChange('')} />}
    </Shell>
  );
}

export type DatePreset = { label: string; value: string };

export function DateInput({ value, onChange, min, max, sm, invalid, clearable, relative = true, presets, 'aria-label': ariaLabel }: {
  value: string; onChange: (v: string) => void; min?: string; max?: string; sm?: boolean; invalid?: boolean;
  /** Optional dates: an × to empty the field. */
  clearable?: boolean;
  /** Show "In 8 months" / "3 days ago" inside the field. */
  relative?: boolean;
  /** Quick picks shown as chips under the field. Presets outside min/max are left out. */
  presets?: DatePreset[];
  'aria-label'?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const open = () => { try { ref.current?.showPicker?.(); } catch { /* not allowed (e.g. no user gesture); typing still works */ } };
  const shell = (
    <Shell sm={sm} invalid={invalid} className={cx('date', !value && 'is-empty')}>
      <span className="addon"><Calendar /></span>
      <input ref={ref} type="date" value={value} min={min} max={max} aria-label={ariaLabel} aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value)} onClick={open} />
      {relative && value && <span className="addon rel">{relDate(value)}</span>}
      {clearable && value && <ClearButton label="Clear date" onClick={() => onChange('')} />}
    </Shell>
  );
  const usable = presets?.filter((p) => (!min || p.value >= min) && (!max || p.value <= max));
  if (!usable?.length) return shell;
  return (
    <div className="date-field">
      {shell}
      <div className="chips">
        {usable.map((p) => <button key={p.label} type="button" className={cx('chip', 'sm', p.value === value && 'on')} onClick={() => onChange(p.value)}>{p.label}</button>)}
      </div>
    </div>
  );
}

// -- inline title --

// A name that reads as a heading until you edit it. Saves on Enter or blur when it changed; Esc puts it back
// (and doesn't close the sheet). Empty reverts unless `allowEmpty` (e.g. "reset to the bank's name").
export function InlineEdit({ value, onCommit, placeholder, allowEmpty, className, 'aria-label': ariaLabel }: { value: string; onCommit: (v: string) => void; placeholder?: string; allowEmpty?: boolean; className?: string; 'aria-label': string }) {
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.trim();
    if (cancelled.current || v === value.trim() || (!v && !allowEmpty)) {
      cancelled.current = false;
      setDraft(value);
      return;
    }
    onCommit(v);
  };
  return (
    <span className={cx('inline-edit', className)}>
      <input
        className="input" value={draft} placeholder={placeholder} aria-label={ariaLabel} spellCheck={false}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') { e.stopPropagation(); cancelled.current = true; e.currentTarget.blur(); }
        }}
      />
      <Pencil aria-hidden />
    </span>
  );
}

// -- choices --

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  sm?: boolean; auto?: boolean; invalid?: boolean;
  /** filter: toolbar filter that highlights while set (value ≠ ""); add: dashed "+ …" action whose first option is the prompt. */
  variant?: 'filter' | 'add';
  icon?: ReactNode;
  /** filter only: an × that resets it while it's set. */
  onClear?: () => void;
};

export function Select({ className, style, sm, auto, invalid, variant, icon, onClear, children, ...rest }: SelectProps) {
  const set = variant === 'filter' && rest.value != null && rest.value !== '';
  const lead = icon ?? (variant === 'add' ? <Plus /> : null);
  return (
    <div className={cx('select-wrap', sm && 'sm', auto && 'auto', variant, set && 'on', className)} style={style}>
      {lead && <span className="lead" aria-hidden>{lead}</span>}
      <select className={cx('select', sm && 'sm', lead != null && 'has-lead')} aria-invalid={invalid || undefined} {...rest}>{children}</select>
      {set && onClear ? <ClearButton label="Clear filter" onClick={onClear} /> : <ChevronDown className="chev" aria-hidden />}
    </div>
  );
}

// Looks like a Select; opens a sheet or popover instead (choices that need search or richer rows).
export function PickerButton({ children, placeholder, onClick, onClear, clearLabel = 'Clear', sm, 'aria-label': ariaLabel }: { children?: ReactNode; placeholder: ReactNode; onClick: () => void; onClear?: () => void; clearLabel?: string; sm?: boolean; 'aria-label'?: string }) {
  const has = children != null && children !== false;
  return (
    <Shell sm={sm} className="picker">
      <button type="button" className="pick" onClick={onClick} aria-label={ariaLabel} aria-haspopup="dialog">
        {has ? children : <span className="faint">{placeholder}</span>}
      </button>
      {has && onClear && <ClearButton label={clearLabel} onClick={onClear} />}
      <span className="addon"><ChevronRight /></span>
    </Shell>
  );
}

export function EmojiPicker({ value, options, onChange, label = 'Icon' }: { value: string; options: string[]; onChange: (v: string) => void; label?: string }) {
  return (
    <div className="emoji-grid" role="radiogroup" aria-label={label}>
      {options.map((e) => <button key={e} type="button" role="radio" aria-checked={e === value} className={e === value ? 'on' : ''} onClick={() => onChange(e)} aria-label={e}>{e}</button>)}
    </div>
  );
}

export function SwatchPicker({ value, options, onChange, label = 'Colour' }: { value: string; options: string[]; onChange: (v: string) => void; label?: string }) {
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {options.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={c === value} aria-label={c} className={c === value ? 'on' : ''} style={vars({ '--c': c })} onClick={() => onChange(c)}>
          {c === value && <Check aria-hidden />}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, size }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; size?: 'sm' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current?.querySelector<HTMLButtonElement>('button.on');
      setThumb(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [value, options.length]);
  return (
    <div className={cx('segmented', size)} role="tablist" ref={ref}>
      {thumb && <span className="seg-thumb" style={{ left: thumb.left, width: thumb.width }} />}
      {options.map((o) => (
        <button key={String(o.value)} role="tab" aria-selected={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} type="button">
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)} />;
}

export function MonthSwitch({ month, onChange, max = thisMonth() }: { month: string; onChange: (m: string) => void; max?: string }) {
  return (
    <div className="month-switch">
      <button className="btn ghost icon-btn sm" aria-label="Previous month" onClick={() => onChange(shiftMonth(month, -1))}>
        <ChevronLeft />
      </button>
      <span className="label">{monthLabel(month)}</span>
      <button className="btn ghost icon-btn sm" aria-label="Next month" disabled={month >= max} onClick={() => onChange(shiftMonth(month, 1))}>
        <ChevronRight />
      </button>
    </div>
  );
}

// ---- labels -------------------------------------------------------------------

export function Badge({ tone, children, icon, title, className }: { tone?: 'accent' | 'good' | 'warn' | 'bad' | 'outline'; children: ReactNode; icon?: ReactNode; title?: string; className?: string }) {
  return <span className={cx('badge', tone, className)} title={title}>{icon}{children}</span>;
}

type CatLike = Pick<Category, 'emoji' | 'color' | 'name'> | null | undefined;

// Colour square + emoji + name. The standard way to show a category anywhere.
export function CatLabel({ cat, onClick, emoji = true, className }: { cat: CatLike; onClick?: () => void; emoji?: boolean; className?: string }) {
  const inner = (
    <>
      <i className="sw" />
      {emoji && <span className="e">{cat?.emoji || '·'}</span>}
      <span className="n">{cat?.name || 'Uncategorized'}</span>
    </>
  );
  const style = vars({ '--c': cat?.color || 'var(--text-3)' });
  if (onClick) return <button type="button" className={cx('cat-label', !cat && 'none', className)} style={style} onClick={onClick}>{inner}</button>;
  return <span className={cx('cat-label', !cat && 'none', className)} style={style}>{inner}</span>;
}

export function CatPill({ cat, onClick }: { cat?: CatLike; onClick?: () => void }) {
  const C = onClick ? 'button' : 'span';
  return (
    <C className="cat-pill" style={vars({ '--c': cat?.color || '#8e8e93' })} onClick={onClick} type={onClick ? 'button' : undefined}>
      <span className="e">{cat?.emoji || '🏷️'}</span>
      <span className="ellipsis">{cat?.name || 'Uncategorized'}</span>
    </C>
  );
}

// ---- money --------------------------------------------------------------------

export function Money({ value, cents = true, sign = false, className = '' }: { value: number | null | undefined; cents?: boolean; sign?: boolean; className?: string }) {
  return <span className={`num ${className}`}>{money(value, { cents, sign })}</span>;
}

export function Delta({ value, invert = false, format = 'money', suffix }: { value: number; invert?: boolean; format?: 'money' | 'pct'; suffix?: string }) {
  const good = invert ? value < 0 : value > 0;
  const flat = Math.abs(value) < (format === 'pct' ? 0.005 : 0.5);
  const Icon = value >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`delta ${flat ? 'flat' : good ? 'good' : 'bad'}`}>
      {!flat && <Icon />}
      <span className="num">{format === 'pct' ? `${Math.abs(Math.round(value * 100))}%` : money(Math.abs(value), { cents: false })}</span>
      {suffix && <span className="faint" style={{ fontWeight: 400, marginLeft: 3 }}>{suffix}</span>}
    </span>
  );
}

// ---- avatars ------------------------------------------------------------------

export function CatAvatar({ cat, size = '', round = false }: { cat?: Pick<Category, 'emoji' | 'color'> | null; size?: '' | 'sm' | 'lg' | 'xl'; round?: boolean }) {
  return (
    <span className={`avatar ${size} ${round ? 'round' : ''}`} style={vars({ '--c': cat?.color || '#8e8e93' })}>
      {cat?.emoji || '🏷️'}
    </span>
  );
}

export function MerchantAvatar({ logo, cat, size = '' }: { name?: string; logo?: string | null; cat?: Pick<Category, 'emoji' | 'color'> | null; size?: '' | 'sm' | 'lg' | 'xl' }) {
  const [failed, setFailed] = useState(false);
  if (logo && !failed)
    return (
      <span className={`avatar ${size}`} style={vars({ '--c': cat?.color || '#8e8e93' })}>
        <img src={logo} alt="" loading="lazy" onError={() => setFailed(true)} />
      </span>
    );
  return <CatAvatar cat={cat} size={size} />;
}

// ---- progress -----------------------------------------------------------------

export function Bar({ value, max, color, pace, size = '' }: { value: number; max: number; color?: string; pace?: number | null; size?: '' | 'thin' | 'thick' }) {
  const ratio = max > 0 ? value / max : value > 0 ? 1 : 0;
  return (
    <div className={`bar ${size}`} role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
      <i className={ratio > 1 ? 'over' : ''} style={vars({ width: `${Math.min(Math.max(ratio, 0), 1) * 100}%`, '--c': color })} />
      {pace != null && pace > 0 && pace < 1 && <span className="pace" style={{ left: `${pace * 100}%` }} title="Where you'd be at an even pace" />}
    </div>
  );
}

// Bar + percentage, sized for a table cell.
export function Meter({ value, max, color, pace, showPct = true }: { value: number; max: number; color?: string; pace?: number | null; showPct?: boolean }) {
  const ratio = max > 0 ? value / max : 0;
  return (
    <div className={cx('meter', ratio > 1 && 'over')}>
      <Bar value={value} max={max} color={color} pace={pace} size="thin" />
      {showPct && <span className="pct">{max > 0 ? `${Math.round(ratio * 100)}%` : '—'}</span>}
    </div>
  );
}

export function Ring({ value, max, size = 120, stroke = 12, color = 'var(--accent)', children }: { value: number; max: number; size?: number; stroke?: number; color?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const ratio = max > 0 ? Math.min(value / max, 1) : 0;
  const over = max > 0 && value > max;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        <circle
          className="ring-val" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round"
          stroke={over ? 'var(--red)' : color === 'grad' ? 'var(--accent)' : color} strokeDasharray={c} strokeDashoffset={c * (1 - ratio)}
        />
      </svg>
      <div className="ring-label">{children}</div>
    </div>
  );
}

export function Sparkline({ data, width = 80, height = 22, color }: { data: number[]; width?: number; height?: number; color?: string }) {
  if (!data || data.length < 2) return <svg className="spark" width={width} height={height} />;
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * width, height - 2 - ((v - min) / span) * (height - 4)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const up = data[data.length - 1] >= data[0];
  const stroke = color || (up ? 'var(--green)' : 'var(--red)');
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ---- empty & loading ----------------------------------------------------------

export function Empty({ icon, emoji, title, children, action, compact }: { icon?: ReactNode; emoji?: string; title: string; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx('empty', compact && 'compact')}>
      {icon ? <div className="icon">{icon}</div> : emoji ? <div className="emoji">{emoji}</div> : null}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Skel({ w = '100%', h = 14, r = 4, style }: { w?: number | string; h?: number; r?: number; style?: CSSProperties }) {
  return <div className="skel" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

export function SkelRows({ n = 6 }: { n?: number }) {
  return (
    <div className="list">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="rowlink">
          <Skel w={20} h={20} r={5} />
          <Skel w={`${40 + ((i * 17) % 30)}%`} h={10} />
          <Skel w={56} h={10} style={{ marginLeft: 'auto' }} />
        </div>
      ))}
    </div>
  );
}

// ---- sheet & modal ------------------------------------------------------------

// Plays the exit animation, then really closes.
function useClosing(onClose: () => void, ms = 150) {
  const [closing, setClosing] = useState(false);
  const done = useRef(false);
  const close = useCallback(() => {
    if (done.current) return;
    done.current = true;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return onClose();
    setClosing(true);
    setTimeout(onClose, ms);
  }, [onClose, ms]);
  return [closing, close] as const;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', h);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
}

// Right-hand drawer on desktop, bottom sheet on phones (CSS decides). Drag the grabber down to dismiss.
// size: md 480px (details), lg 720px (editors with two-column forms), xl 960px (tables).
export function Sheet({ title, onClose, children, footer, actions, size = 'md' }: { title?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; actions?: ReactNode; size?: 'md' | 'lg' | 'xl' }) {
  const [closing, close] = useClosing(onClose);
  useEscape(close);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, dy: 0 };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (ref.current) ref.current.style.transition = 'none';
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !ref.current) return;
    const dy = e.clientY - drag.current.y;
    drag.current.dy = Math.max(0, dy);
    ref.current.style.transform = `translateY(${Math.max(0, dy)}px)`;
  };
  const onPointerUp = () => {
    if (!drag.current || !ref.current) return;
    ref.current.style.transition = 'transform .2s var(--ease-out)';
    if (drag.current.dy > 100) {
      ref.current.style.transform = 'translateY(100%)';
      setTimeout(onClose, 180);
    } else ref.current.style.transform = '';
    drag.current = null;
  };
  return createPortal(
    <>
      <div className={`overlay ${closing ? 'closing' : ''}`} onClick={close} />
      <div className={cx('sheet', size !== 'md' && size, closing && 'closing')} ref={ref} role="dialog" aria-modal="true">
        <div className="grabber" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
        <div className="sheet-head">
          <h2 className="grow ellipsis">{title}</h2>
          {actions}
          <button className="btn ghost icon-btn sm" onClick={close} aria-label="Close" title="Close (Esc)">
            <X />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </>,
    document.body,
  );
}

export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const [closing, close] = useClosing(onClose, 120);
  useEscape(close);
  return createPortal(
    <>
      <div className={`overlay ${closing ? 'closing' : ''}`} onClick={close} />
      <div className={`modal ${closing ? 'closing' : ''}`} role="dialog" aria-modal="true">
        {children}
      </div>
    </>,
    document.body,
  );
}

export { useClosing, useEscape };

// ---- toasts -------------------------------------------------------------------

type Toast = { id: number; text: string; kind: 'ok' | 'error'; action?: { label: string; run: () => void } };
const ToastCtx = createContext<(text: string, opts?: { kind?: 'ok' | 'error'; action?: Toast['action'] }) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, opts: { kind?: 'ok' | 'error'; action?: Toast['action'] } = {}) => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, kind: opts.kind || 'ok', action: opts.action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.action ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
              {t.kind === 'error' ? <AlertTriangle /> : <Check />}
              <span className="grow">{t.text}</span>
              {t.action && (
                <button
                  onClick={() => {
                    t.action!.run();
                    setToasts((x) => x.filter((y) => y.id !== t.id));
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export { vars, cx };
