import { animate, AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { pref, setPref } from './api.ts';

// Lucide-style 24px stroke icons; decorative unless a label is given.
const P: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  play: 'M7 4v16l13-8z',
  flag: 'M4 22V4m0 0h13l-2 4 2 4H4',
  money: 'M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  clock: 'M12 7v5l3 3M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  upload: 'M12 15V3m0 0-4 4m4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  volume: 'M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  smile: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  link: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  back: 'M15 18l-6-6 6-6',
  next: 'M9 18l6-6-6-6',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  up: 'M18 15l-6-6-6 6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  key: 'M15 7a4 4 0 1 1-3.9 5H9v2H7v2H4v-3l6.1-6.1A4 4 0 0 1 15 7z',
  download: 'M12 3v12m0 0-4-4m4 4 4-4M4 19h16',
};
export const Icon = ({ name, size = 18, label, className = '' }: { name: keyof typeof P | string; size?: number; label?: string; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
    className={`shrink-0 ${className}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}><path d={P[name] ?? P.alert} /></svg>
);

/** Number that counts up on change; jumps straight there with reduced motion. */
export function Counter({ value, format }: { value: number; format: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null), prev = useRef(0), reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce) { el.textContent = format(value); prev.current = value; return; }
    const c = animate(prev.current, value, { duration: 0.8, ease: [0.16, 1, 0.3, 1], onUpdate: (v) => { el.textContent = format(v); } });
    prev.current = value;
    return () => c.stop();
  }, [value, reduce, format]);
  return <span ref={ref} className="num">{format(value)}</span>;
}

// ---- toasts
type Toast = { id: number; text: string; tone: 'up' | 'down' | 'info'; undo?: () => void };
const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function Toasts({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l.slice(-2), { ...t, id }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 items-center pointer-events-none" role="status" aria-live="polite">
        <AnimatePresence>
          {list.map((t) => (
            <motion.div key={t.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
              className="pointer-events-auto flex items-center gap-3 h-12 pl-4 pr-2 rounded-2xl bg-r border border-line shadow-2xl text-sm font-medium">
              <Icon name={t.tone === 'down' ? 'x' : t.tone === 'up' ? 'check' : 'alert'} className={t.tone === 'down' ? 'text-down' : t.tone === 'up' ? 'text-up' : 'text-a'} />
              {t.text}
              {t.undo ? <button className="seg text-a" onClick={t.undo}>Undo</button> : <span className="w-2" />}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

/** Rows appear in pages as the list scrolls; footer says how many are shown. */
export function useMore<T>(rows: T[], page = 20) {
  const [n, setN] = useState(page), sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) setN((x) => x + page); });
    io.observe(el);
    return () => io.disconnect();
  }, [page, rows.length]);
  const shown = rows.slice(0, n);
  return { shown, sentinel: <div ref={sentinel} aria-hidden className="h-px" />, footer: <More shown={shown.length} total={rows.length} /> };
}
export const More = ({ shown, total }: { shown: number; total: number }) => (
  <div className="more">
    <span>Showing <b className="num text-m font-semibold">{shown}</b> of <b className="num text-m font-semibold">{total}</b></span>
    {shown < total ? <span className="flex gap-2 items-center"><span className="spin" aria-hidden />More load as you scroll</span> : <span>All shown</span>}
  </div>
);

export const Empty = ({ icon, title, text }: { icon: string; title: string; text: string }) => (
  <div className="flex flex-col items-center justify-center text-center gap-3 py-12 px-6 flex-1">
    <span className="w-12 h-12 rounded-2xl bg-r flex items-center justify-center text-m"><Icon name={icon} size={22} /></span>
    <div className="font-semibold">{title}</div>
    <div className="text-sm text-f max-w-xs">{text}</div>
  </div>
);

export const Skeleton = ({ className = '' }: { className?: string }) => <div className={`skel ${className}`} aria-hidden />;

export const Stat = ({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) => (
  <div className="card flex flex-col gap-2">
    <span className="text-sm text-m">{label}</span>
    <span className="text-[28px] font-semibold leading-none">{children}</span>
    {sub ? <span className="text-xs text-f">{sub}</span> : null}
  </div>
);

export const Page = ({ back, kicker, title, right, children }: { back?: ReactNode; kicker?: string; title: string; right?: ReactNode; children: ReactNode }) => (
  <motion.main initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
    className="flex-1 min-w-0 min-h-0 flex flex-col gap-6 p-5 md:py-8 md:px-10 pb-28 md:pb-8 md:h-screen md:overflow-hidden">
    <header className="flex flex-wrap items-end justify-between gap-4 shrink-0">
      <div className="flex flex-col gap-2 min-w-0">{back}{kicker ? <span className="kicker !text-m">{kicker}</span> : null}<h1 className="text-[28px] font-bold tracking-[-0.03em] leading-tight m-0 truncate">{title}</h1></div>
      {right}
    </header>
    {children}
  </motion.main>
);

/** USD/EUR switch from the mockup header. EUR only when the ECB rate loaded (api.ts isEur); otherwise it stays on USD. */
export function Currency() {
  const [cur, setCur] = useState(() => pref('currency', 'usd'));
  useEffect(() => { const f = () => setCur(pref('currency', 'usd')); addEventListener('snip-pref', f); return () => removeEventListener('snip-pref', f); }, []);
  return (
    <div role="radiogroup" aria-label="Currency" className="flex p-1 rounded-[14px] bg-s border border-line">
      {(['usd', 'eur'] as const).map((c) => (
        <button key={c} role="radio" aria-checked={cur === c} onClick={() => setPref('currency', c)}
          className={`h-9 px-4 rounded-[10px] text-sm font-medium cursor-pointer transition-colors ${cur === c ? 'bg-r text-t' : 'text-m hover:text-t'}`}>{c.toUpperCase()}</button>))}
    </div>
  );
}
