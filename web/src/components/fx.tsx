// Motion & material helpers: rolling numbers, cursor spotlight, reduced-motion awareness.
import { useEffect, useRef, useState } from 'react';

export const prefersReducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Tweens a number toward its target (ease-out expo). First mount rolls up from 82% of the value.
export function useTween(target: number, ms = 900) {
  const [v, setV] = useState(() => (prefersReducedMotion() ? target : target * 0.82));
  const from = useRef(v);
  const raf = useRef(0);
  useEffect(() => {
    if (prefersReducedMotion()) {
      setV(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    cancelAnimationFrame(raf.current);
    const step = (now: number) => {
      const t = Math.min((now - start) / ms, 1);
      const e = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      const x = a + (target - a) * e;
      from.current = x;
      setV(x);
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms]);
  return v;
}

const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

// Big money figure with small superscript cents (Copilot/Apple Wallet style), rolling between values.
export function RollingMoney({ value, cents = true, className = '', instant = false }: { value: number; cents?: boolean; className?: string; instant?: boolean }) {
  const tweened = useTween(value);
  const v = instant ? value : tweened;
  const neg = v < -0.004;
  const abs = Math.abs(v);
  const dollars = cents ? Math.floor(abs + 1e-9) : Math.round(abs);
  const c = Math.round((abs - Math.floor(abs + 1e-9)) * 100) % 100;
  return (
    <span className={`num ${className}`} aria-label={`${neg ? 'minus ' : ''}$${abs.toFixed(cents ? 2 : 0)}`}>
      <span aria-hidden>
        {neg ? '−' : ''}${whole.format(dollars)}
        {cents && <span className="cents">.{String(c).padStart(2, '0')}</span>}
      </span>
    </span>
  );
}
