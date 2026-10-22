// Per-device display preferences (localStorage + attributes on <html>, applied pre-paint by public/theme.js).
import { useEffect, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';
export type Accent = 'blue' | 'violet' | 'ocean' | 'mint' | 'rose' | 'sunset';
// Hues match the [data-accent] rules in styles/app.css; 'blue' is the default (no attribute).
export const ACCENTS: { value: Accent; label: string; color: string }[] = [
  { value: 'blue', label: 'Blue', color: 'oklch(64% .15 255)' },
  { value: 'violet', label: 'Violet', color: 'oklch(64% .15 288)' },
  { value: 'ocean', label: 'Ocean', color: 'oklch(64% .15 225)' },
  { value: 'mint', label: 'Mint', color: 'oklch(64% .15 165)' },
  { value: 'rose', label: 'Rose', color: 'oklch(64% .15 355)' },
  { value: 'sunset', label: 'Sunset', color: 'oklch(64% .15 45)' },
];
export type Density = 'compact' | 'default' | 'comfortable';

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {}
};
const root = () => document.documentElement;

export const getTheme = (): Theme => (read('tally-theme') as Theme) || 'system';
export function setTheme(t: Theme) {
  write('tally-theme', t === 'system' ? null : t);
  if (t === 'system') delete root().dataset.theme;
  else root().dataset.theme = t;
  window.dispatchEvent(new Event('tally:prefs'));
}
export const getAccent = (): Accent => (read('tally-accent') as Accent) || 'blue';
export function setAccent(a: Accent) {
  write('tally-accent', a === 'blue' ? null : a);
  if (a === 'blue') delete root().dataset.accent;
  else root().dataset.accent = a;
  window.dispatchEvent(new Event('tally:prefs'));
}
export const getDensity = (): Density => (read('tally-density') as Density) || 'default';
export function setDensity(d: Density) {
  write('tally-density', d === 'default' ? null : d);
  if (d === 'default') delete root().dataset.density;
  else root().dataset.density = d;
  window.dispatchEvent(new Event('tally:prefs'));
}
export const getPrivacy = () => read('tally-privacy') === 'on';
export function setPrivacy(on: boolean) {
  write('tally-privacy', on ? 'on' : null);
  if (on) root().dataset.privacy = 'on';
  else delete root().dataset.privacy;
  window.dispatchEvent(new Event('tally:prefs'));
}

// Re-renders when any preference changes (also from the command palette).
export function usePrefs() {
  const snap = () => ({ theme: getTheme(), accent: getAccent(), density: getDensity(), privacy: getPrivacy() });
  const [p, setP] = useState(snap);
  useEffect(() => {
    const h = () => setP(snap());
    window.addEventListener('tally:prefs', h);
    return () => window.removeEventListener('tally:prefs', h);
  }, []);
  return p;
}
