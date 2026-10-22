import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { ACCENTS, setAccent, setDensity, setPrivacy, setTheme, usePrefs, type Density, type Theme } from '../../lib/prefs';
import { Badge, Button, CatLabel, DataTable, FormRow, Meter, Panel, Segmented, Switch, vars } from '../../components/ui';
import { SettingsHeader } from './SettingsLayout';

const THEMES: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: 'system', label: 'Automatic', icon: <Monitor /> },
  { value: 'light', label: 'Light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', icon: <Moon /> },
];

// A tiny drawing of the app in each theme so the choice is visual, not a word.
function Mini({ kind }: { kind: 'light' | 'dark' }) {
  return (
    <span className={`mini mini-${kind}`}>
      <span className="mini-side" />
      <span className="mini-main">
        <span className="mini-line w40" />
        <span className="mini-card"><span className="mini-line w70" /><span className="mini-line w40" /><span className="mini-line w70" /></span>
      </span>
    </span>
  );
}

const SAMPLE = [
  { id: 1, name: 'Trader Joe’s', cat: { emoji: '🛒', color: '#34c759', name: 'Groceries' }, spent: 412, budget: 600 },
  { id: 2, name: 'Blue Bottle', cat: { emoji: '☕', color: '#ac8e68', name: 'Coffee' }, spent: 74, budget: 80 },
  { id: 3, name: 'Parkside Apartments', cat: { emoji: '🏠', color: '#5e5ce6', name: 'Rent & Mortgage' }, spent: 2150, budget: 2150 },
  { id: 4, name: 'Chevron', cat: { emoji: '⛽', color: '#ff453a', name: 'Car & Gas' }, spent: 188, budget: 150 },
];

export default function Appearance() {
  const prefs = usePrefs();
  return (
    <>
      <SettingsHeader title="Appearance" sub="Saved on this device. Motion follows your device's reduce-motion setting." />
      <div className="appearance">
        <Panel title="Display">
          <FormRow label="Theme">
            <div className="theme-tiles">
              {THEMES.map((t) => (
                <button key={t.value} type="button" className={`theme-tile ${prefs.theme === t.value ? 'on' : ''}`} onClick={() => setTheme(t.value)} aria-pressed={prefs.theme === t.value}>
                  {t.value === 'system' ? <span className="mini-split"><Mini kind="light" /><Mini kind="dark" /></span> : <Mini kind={t.value} />}
                  <span className="lbl">{t.icon}{t.label}</span>
                </button>
              ))}
            </div>
          </FormRow>
          <FormRow label="Accent" hint="Selection, focus and primary buttons">
            <div className="accent-row">
              {ACCENTS.map((a) => (
                <button key={a.value} type="button" className={`accent-opt ${prefs.accent === a.value ? 'on' : ''}`} style={vars({ '--c': a.color })} onClick={() => setAccent(a.value)} aria-pressed={prefs.accent === a.value}>
                  <i />{a.label}{prefs.accent === a.value && <Check size={13} />}
                </button>
              ))}
            </div>
          </FormRow>
          <FormRow label="Density" hint="Row height in tables and lists">
            <div>
              <Segmented value={prefs.density} onChange={(v: Density) => setDensity(v)} options={[{ value: 'compact', label: 'Compact' }, { value: 'default', label: 'Default' }, { value: 'comfortable', label: 'Comfortable' }]} />
            </div>
          </FormRow>
          <FormRow label="Privacy mode" hint="Blur balances and amounts, e.g. in public. Hover a number to peek. Also in ⌘K.">
            <div><Switch on={prefs.privacy} label="Privacy mode" onChange={setPrivacy} /></div>
          </FormRow>
        </Panel>

        <Panel title="Preview" meta="Updates as you change settings" flush>
          <DataTable
            sticky={false}
            rows={SAMPLE}
            rowKey={(r) => r.id}
            onRowClick={() => {}}
            selected={2}
            columns={[
              { key: 'c', header: 'Category', wide: true, cell: (r) => <CatLabel cat={r.cat} /> },
              { key: 'm', header: 'Spent', width: 120, hide: 'sm', cell: (r) => <Meter value={r.spent} max={r.budget} color={r.cat.color} /> },
              { key: 'a', header: 'Amount', num: true, cell: (r) => `$${r.spent.toLocaleString()}` },
            ]}
          />
          <div className="panel-foot">
            <span className="row"><Badge tone="accent">Selected</Badge><Badge tone="good">On track</Badge><Badge tone="bad">Over</Badge></span>
            <Button size="sm" variant="primary" tabIndex={-1}>Primary</Button>
          </div>
        </Panel>
      </div>
    </>
  );
}
