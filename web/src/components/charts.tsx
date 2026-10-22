import { useEffect, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { money, moneyCompact, monthShort, shortDate } from '../lib/format';

// Recharts draws SVG attributes, which can't use CSS variables reliably; read the live token values instead.
const TOKENS = ['--accent', '--green', '--red', '--yellow', '--text-2', '--text-3', '--grid', '--chart-prev', '--surface', '--border-strong'] as const;
type Theme = Record<(typeof TOKENS)[number], string>;
function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(TOKENS.map((t) => [t, cs.getPropertyValue(t).trim()])) as Theme;
}
export function useTheme() {
  const [t, setT] = useState<Theme>(readTheme);
  useEffect(() => {
    const update = () => setT(readTheme());
    const mq = matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] });
    return () => {
      mq.removeEventListener('change', update);
      mo.disconnect();
    };
  }, []);
  return t;
}

type TTRow = { label: string; value: string; color?: string };
function TT({ title, rows }: { title: string; rows: TTRow[] }) {
  return (
    <div className="tt">
      <div className="tt-title">{title}</div>
      {rows.map((r) => (
        <div className="tt-row" key={r.label}>
          <span>
            {r.color && <i style={{ background: r.color }} />}
            {r.label}
          </span>
          <b>{r.value}</b>
        </div>
      ))}
    </div>
  );
}

const axis = (t: Theme) => ({ stroke: 'none', tick: { fill: t['--text-3'], fontSize: 11 }, tickLine: false, axisLine: false });

type MouseState = { activeTooltipIndex?: number | string | null } | null | undefined;
const idxOf = (st: MouseState) => (st?.activeTooltipIndex == null ? null : Number(st.activeTooltipIndex));

// A small marker on the latest point of a series ("you are here").
function liveDot(lastIndex: number, color: string, surface: string) {
  return (props: { cx?: number; cy?: number; index?: number }) =>
    props.index === lastIndex && props.cx != null && props.cy != null ? (
      <g key="live">
        <circle cx={props.cx} cy={props.cy} r={3.5} fill={color} stroke={surface} strokeWidth={1.5} />
      </g>
    ) : (
      <g key={props.index} />
    );
}

// Cumulative spending this month vs last month (Copilot's signature chart). With onScrub, hovering or dragging
// reports the point under the finger instead of showing a tooltip, so the headline number can follow it.
export function SpendingChart({ series, month, budget, onScrub }: {
  series: { day: number; cur: number | null; prev: number | null }[]; month: string; budget?: number;
  onScrub?: (p: { day: number; cur: number | null; prev: number | null } | null) => void;
}) {
  const t = useTheme();
  const mname = monthShort(month);
  const last = series.reduce((m, s, i) => (s.cur != null ? i : m), -1);
  const scrub = (st: MouseState) => {
    const i = idxOf(st);
    onScrub?.(i == null ? null : series[i] ?? null);
  };
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={series} margin={{ top: 14, right: 8, bottom: 0, left: 8 }} onMouseMove={onScrub ? scrub : undefined} onMouseLeave={() => onScrub?.(null)}>
        <CartesianGrid vertical={false} stroke={t['--grid']} />
        <XAxis dataKey="day" {...axis(t)} interval="preserveStartEnd" ticks={[1, 8, 15, 22, series.length]} tickFormatter={(d) => `${mname} ${d}`} />
        <YAxis {...axis(t)} orientation="right" width={52} tickFormatter={(v) => moneyCompact(v)} />
        {budget ? <ReferenceLine y={budget} stroke={t['--text-3']} strokeDasharray="4 4" label={{ value: 'Budget', position: 'insideTopLeft', fill: t['--text-3'], fontSize: 11 }} strokeWidth={1} /> : null}
        <Tooltip
          cursor={{ stroke: t['--text-3'], strokeWidth: 1, strokeDasharray: '3 3' }}
          content={({ active, payload, label }) =>
            onScrub || !active || !payload?.length ? null : (
              <TT
                title={`${mname} ${label}`}
                rows={[
                  ...(payload.find((p) => p.dataKey === 'cur')?.value != null ? [{ label: 'This month', value: money(Number(payload.find((p) => p.dataKey === 'cur')!.value)), color: t['--accent'] }] : []),
                  ...(payload.find((p) => p.dataKey === 'prev')?.value != null ? [{ label: 'Last month', value: money(Number(payload.find((p) => p.dataKey === 'prev')!.value)), color: t['--chart-prev'] }] : []),
                ]}
              />
            )
          }
        />
        <Line type="monotone" dataKey="prev" stroke={t['--chart-prev']} strokeWidth={1.5} strokeDasharray="4 4" dot={false} activeDot={{ r: 3, fill: t['--chart-prev'], stroke: 'none' }} isAnimationActive={false} />
        <Area type="monotone" dataKey="cur" stroke={t['--accent']} strokeWidth={2} fill={t['--accent']} fillOpacity={0.08} connectNulls={false}
          dot={liveDot(last, t['--accent'], t['--surface'])}
          activeDot={{ r: 4, fill: t['--accent'], stroke: t['--surface'], strokeWidth: 2 }} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

type NW = { date: string; net: number; assets: number; liabilities: number };
export function NetWorthChart({ data, mode = 'net', onScrub }: { data: NW[]; mode?: 'net' | 'split'; onScrub?: (p: NW | null) => void }) {
  const t = useTheme();
  const up = data.length > 1 && data[data.length - 1].net >= data[0].net;
  const c = up ? t['--green'] : t['--red'];
  const span = data.length;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: 8 }}
        onMouseMove={onScrub ? (st: MouseState) => { const i = idxOf(st); onScrub(i == null ? null : data[i] ?? null); } : undefined}
        onMouseLeave={() => onScrub?.(null)}>
        <CartesianGrid vertical={false} stroke={t['--grid']} />
        <XAxis dataKey="date" {...axis(t)} minTickGap={48} tickFormatter={(d) => (span > 200 ? new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) : shortDate(d))} />
        <YAxis {...axis(t)} orientation="right" width={56} domain={['auto', 'auto']} tickFormatter={(v) => moneyCompact(v)} />
        <Tooltip
          cursor={{ stroke: t['--text-3'], strokeDasharray: '3 3' }}
          content={({ active, payload, label }) => {
            if (onScrub || !active || !payload?.length) return null;
            const p = payload[0].payload as { net: number; assets: number; liabilities: number };
            return (
              <TT
                title={shortDate(String(label))}
                rows={[
                  { label: 'Net worth', value: money(p.net, { cents: false }), color: c },
                  { label: 'Assets', value: money(p.assets, { cents: false }) },
                  { label: 'Liabilities', value: money(p.liabilities, { cents: false }) },
                ]}
              />
            );
          }}
        />
        {mode === 'split' && <Area type="monotone" dataKey="assets" stroke={t['--accent']} strokeWidth={1.75} fill={t['--accent']} fillOpacity={0.07} dot={false} isAnimationActive={false} />}
        {mode === 'split' && <Area type="monotone" dataKey="liabilities" stroke={t['--red']} strokeWidth={1.75} fill="none" dot={false} isAnimationActive={false} />}
        {mode === 'net' && <Area type="monotone" dataKey="net" stroke={c} strokeWidth={1.75} fill={c} fillOpacity={0.07} dot={liveDot(data.length - 1, c, t['--surface'])} activeDot={{ r: 4, fill: c, stroke: t['--surface'], strokeWidth: 2 }} isAnimationActive={false} />}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function CashFlowChart({ data, selected, onSelect }: { data: { month: string; income: number; expenses: number; net: number }[]; selected?: string; onSelect?: (m: string) => void }) {
  const t = useTheme();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: 8 }} barGap={2} barCategoryGap="30%"
        onClick={(e) => { const m = (e as { activeLabel?: string } | null)?.activeLabel; if (m && onSelect) onSelect(String(m)); }}>
        <CartesianGrid vertical={false} stroke={t['--grid']} />
        <XAxis dataKey="month" {...axis(t)} tickFormatter={(m) => monthShort(m)} />
        <YAxis {...axis(t)} orientation="right" width={52} tickFormatter={(v) => moneyCompact(v)} />
        <Tooltip
          cursor={{ fill: t['--grid'] }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as { income: number; expenses: number; net: number };
            return (
              <TT
                title={new Date(label + '-01T12:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                rows={[
                  { label: 'Income', value: money(p.income, { cents: false }), color: t['--green'] },
                  { label: 'Spending', value: money(p.expenses, { cents: false }), color: t['--accent'] },
                  { label: 'Net', value: money(p.net, { cents: false, sign: true }) },
                ]}
              />
            );
          }}
        />
        <Bar dataKey="income" radius={[2, 2, 0, 0]} maxBarSize={22} isAnimationActive={false}>
          {data.map((d) => <Cell key={d.month} fill={t['--green']} fillOpacity={!selected || selected === d.month ? 0.85 : 0.3} cursor="pointer" />)}
        </Bar>
        <Bar dataKey="expenses" radius={[2, 2, 0, 0]} maxBarSize={22} isAnimationActive={false}>
          {data.map((d) => <Cell key={d.month} fill={t['--accent']} fillOpacity={!selected || selected === d.month ? 0.85 : 0.3} cursor="pointer" />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function TrendBars({ data, color }: { data: { month: string; total: number }[]; color: string }) {
  const t = useTheme();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
        <XAxis dataKey="month" {...axis(t)} tickFormatter={(m) => monthShort(m)} />
        <Tooltip cursor={{ fill: t['--grid'] }} content={({ active, payload, label }) => (active && payload?.length ? <TT title={String(label)} rows={[{ label: 'Spent', value: money(Number(payload[0].value)) }]} /> : null)} />
        <Bar dataKey="total" radius={[2, 2, 0, 0]} fill={color} fillOpacity={0.85} maxBarSize={24} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Donut({ data, size = 200, children, onSelect }: { data: { id: number; name: string; value: number; color: string }[]; size?: number; children?: React.ReactNode; onSelect?: (id: number) => void }) {
  const t = useTheme();
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <PieChart width={size} height={size}>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={size * 0.36} outerRadius={size / 2 - 2} paddingAngle={1} cornerRadius={1} stroke="none"
          startAngle={90} endAngle={-270} isAnimationActive={false} onClick={(d) => onSelect?.((d as unknown as { id: number }).id)}>
          {data.map((d) => <Cell key={d.id} fill={d.color} cursor={onSelect ? 'pointer' : undefined} />)}
        </Pie>
        <Tooltip content={({ active, payload }) => (active && payload?.length ? <TT title={String(payload[0].name)} rows={[{ label: 'Spent', value: money(Number(payload[0].value)) }]} /> : null)} />
      </PieChart>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none', textAlign: 'center', color: t['--text-2'] }}>{children}</div>
    </div>
  );
}

// Month-end balance of a goal, with its target as a dashed line.
export function GoalChart({ data, color, target }: { data: { month: string; balance: number }[]; color: string; target?: number | null }) {
  const t = useTheme();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid vertical={false} stroke={t['--grid']} />
        <XAxis dataKey="month" {...axis(t)} tickFormatter={(m) => monthShort(m)} minTickGap={20} />
        <YAxis {...axis(t)} orientation="right" width={52} tickFormatter={(v) => moneyCompact(v)} domain={[0, (max: number) => Math.max(max, target || 0) * 1.08]} />
        {target ? <ReferenceLine y={target} stroke={t['--text-3']} strokeDasharray="4 4" label={{ value: 'Goal', position: 'insideTopLeft', fill: t['--text-3'], fontSize: 11 }} /> : null}
        <Tooltip cursor={{ stroke: t['--text-3'], strokeDasharray: '3 3' }}
          content={({ active, payload, label }) => (active && payload?.length ? <TT title={new Date(label + '-01T12:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} rows={[{ label: 'Balance', value: money(Number(payload[0].value)), color }]} /> : null)} />
        <Area type="monotone" dataKey="balance" stroke={color} strokeWidth={1.75} fill={color} fillOpacity={0.08} dot={liveDot(data.length - 1, color, t['--surface'])} activeDot={{ r: 4, fill: color, stroke: t['--surface'], strokeWidth: 2 }} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
