import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig, motion } from 'motion/react';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { pref, setRate, useOverview, useRate } from './api.ts';
import { Icon, Page, Toasts } from './ui.tsx';
import { Home } from './pages/Home.tsx';
import { Review } from './pages/Review.tsx';
import { Campaigns, CampaignPage } from './pages/Campaigns.tsx';
import { Later } from './pages/Later.tsx';
import { Settings } from './pages/Settings.tsx';
import { Proposals } from './pages/Proposals.tsx';
import { Discover } from './pages/Discover.tsx';
import { Accounts, Earnings, History } from './pages/Money.tsx';
import './index.css';

// Hash routes: #/, #/review, #/campaigns, #/campaigns/<name>, #/discover, #/earnings, #/history, #/accounts, #/settings
// Old Bark/Discord links end in #clip-<id>; send those to that clip in Review.
const read = () => { const h = location.hash.slice(1) || '/'; return /^clip-\d+$/.test(h) ? `/review/${h.slice(5)}` : h === '/ready' ? '/campaigns' : h; };
const useRoute = () => {
  const [h, setH] = useState(read);
  useEffect(() => { const f = () => setH(read()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
};

const NAV: [string, string, string, string?][] = [
  ['/', 'Home', 'home'],
  ['/review', 'Review', 'play', 'Clips'],
  ['/campaigns', 'Campaigns', 'flag', 'Money'],
  ['/earnings', 'Earnings', 'money'],
  ['/history', 'History', 'clock'],
  ['/proposals', 'Proposals', 'smile', 'Learning'],
];
const BOTTOM: [string, string, string][] = [['/accounts', 'Accounts', 'user'], ['/settings', 'Settings', 'gear']];

function Side({ route }: { route: string }) {
  const { data } = useOverview();
  const cur = (p: string) => (p === '/' ? route === '/' : route.startsWith(p) || (p === '/campaigns' && route === '/discover')) ? 'page' : undefined;
  const link = ([p, label, icon]: [string, string, string, string?]) => (
    <a key={p} href={`#${p}`} className="nav" aria-current={cur(p)}>
      {cur(p) ? <motion.span layoutId="side-ind" className="absolute inset-0 -z-10 rounded-[12px] bg-r" transition={{ type: 'spring', stiffness: 500, damping: 40 }} /> : null}
      <Icon name={icon} />{label}
      {p === '/review' && data?.toReview ? <span className="badge num">{data.toReview}</span> : null}
      {p === '/campaigns' && data?.toPost ? <span className="badge num" title="Kept clips ready to post">{data.toPost}</span> : null}</a>
  );
  return (
    <aside className="hidden md:flex w-[248px] shrink-0 h-screen flex-col gap-1 py-6 px-4 border-r border-line">
      <a href="#/" className="flex items-center gap-2 h-12 px-3 mb-4 no-underline"><span className="w-8 h-8 rounded-[10px] bg-p flex items-center justify-center"><Icon name="scissors" size={16} /></span><span className="text-lg font-semibold truncate">{pref('appName', 'Snip') || 'Snip'}</span></a>
      {NAV.map((n) => <div key={n[0]}>{n[3] ? <div className="kicker pt-4 px-3 pb-1.5">{n[3]}</div> : null}{link(n)}</div>)}
      <div className="mt-auto flex flex-col gap-1">
        {BOTTOM.map((n) => link(n))}
        <div className="mt-3 p-3 rounded-[14px] bg-s border border-line flex items-center gap-2 text-sm">
          <span className="dot" style={{ background: data?.paused ? 'var(--color-warn)' : 'var(--color-up)' }} />
          <span className="flex-1">{data ? (data.paused ? 'Paused' : 'Running') : 'Connecting…'}</span>
          {data && !data.paused ? <span className="kicker !text-m num">{data.working} job{data.working === 1 ? '' : 's'}</span> : null}
        </div>
      </div>
    </aside>
  );
}

// Mobile: pages without their own bottom tab (max 5 tabs) live behind More.
const MORE = [...NAV, ...BOTTOM].filter(([p]) => !['/', '/review', '/campaigns', '/earnings'].includes(p));
function More() {
  return (
    <Page title="More">
      <nav className="card !p-0 flex flex-col divide-y divide-line overflow-hidden" aria-label="More pages">
        {MORE.map(([p, label, icon]) => <a key={p} href={`#${p}`} className="flex items-center gap-3 px-5 min-h-14 no-underline hover:bg-r active:bg-r transition-colors"><Icon name={icon} />
          <span className="flex-1 font-medium">{label}</span><Icon name="next" size={16} className="text-f" /></a>)}
      </nav>
    </Page>
  );
}

function Tabs({ route }: { route: string }) {
  const { data } = useOverview();
  const tabs: [string, string, string][] = [['/', 'Home', 'home'], ['/review', 'Review', 'play'], ['/campaigns', 'Campaigns', 'flag'], ['/earnings', 'Earnings', 'money'], ['/more', 'More', 'menu']];
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 h-20 pb-4 bg-bg/95 backdrop-blur border-t border-line grid grid-cols-5" aria-label="Main">
      {tabs.map(([p, label, icon]) => {
        const on = p === '/' ? route === '/' : route.startsWith(p) || (p === '/campaigns' && route === '/discover') || (p === '/more' && MORE.some(([m]) => route.startsWith(m)));
        return <a key={p} href={`#${p}`} aria-current={on ? 'page' : undefined} className={`relative flex flex-col items-center justify-center gap-1 text-[11px] font-medium no-underline transition-colors ${on ? 'text-a' : 'text-f'}`}>
          <motion.span animate={{ scale: on ? 1.08 : 1, y: on ? -1 : 0 }} transition={{ duration: 0.18 }} className="flex"><Icon name={icon} size={22} /></motion.span>{label}
          {p === '/review' && data?.toReview ? <span className="badge num absolute top-1 left-1/2 ml-1 h-[18px] min-w-[18px] text-[11px]">{data.toReview}</span> : null}
          {p === '/campaigns' && data?.toPost ? <span className="badge num absolute top-1 left-1/2 ml-1 h-[18px] min-w-[18px] text-[11px]">{data.toPost}</span> : null}
        </a>;
      })}
    </nav>
  );
}

function App() {
  const route = useRoute(), rate = useRate().data?.eurPerUsd ?? null, [, bump] = useState(0);
  setRate(rate); // money() reads it; the page re-renders below when the owner changes currency or fee
  useEffect(() => { const f = () => bump((n) => n + 1); addEventListener('snip-pref', f); return () => removeEventListener('snip-pref', f); }, []);
  const camp = /^\/campaigns\/([a-z0-9_]+)$/.exec(route);
  const page = route === '/' ? <Home />
    : route.startsWith('/review') ? <Review focus={Number(route.split('/')[2]) || undefined} />
    : camp ? <CampaignPage name={camp[1]} />
    : route.startsWith('/campaigns') ? <Campaigns />
    : route === '/discover' ? <Discover />
    : route === '/earnings' ? <Earnings />
    : route === '/history' ? <History />
    : route === '/accounts' ? <Accounts />
    : route === '/settings' ? <Settings />
    : route === '/proposals' ? <Proposals />
    : route === '/more' ? <More />
    : <Later what={route.slice(1)} />;
  return (
    <div className="flex min-h-screen md:h-screen">
      <Side route={route} />
      {page}
      <Tabs route={route} />
    </div>
  );
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } });
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <MotionConfig reducedMotion="user">
        <Toasts><App /></Toasts>
      </MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);
