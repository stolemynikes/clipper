import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ago, count, fee, money, useOverview, type Activity, type Campaign } from '../api.ts';
import { Counter, Currency, Empty, Icon, Page, Skeleton, useMore } from '../ui.tsx';

const ACT: Record<Activity['kind'], [string, string]> = { new: ['scissors', 'text-a'], kept: ['check', 'text-up'], skipped: ['x', 'text-down'], posted: ['upload', 'text-a'] };
const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();

function ListCard({ title, right, children, footer }: { title: string; right?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="card !p-0 flex flex-col min-h-[280px] md:min-h-0">
      <div className="flex items-center justify-between h-14 px-5 shrink-0"><h2 className="text-[17px] font-semibold m-0">{title}</h2>{right}</div>
      <div className="scroll flex-1 min-h-0 flex flex-col px-5">{children}</div>
      {footer}
    </section>
  );
}

const Tile = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="card flex flex-col gap-2 justify-center"><span className="kicker">{label}</span><span className="text-[32px] font-semibold leading-none num">{children}</span></div>
);

/** 30-day earned line from the overview (real totals per day; flat at 0 until something pays). */
function Spark({ series }: { series: number[] }) {
  const max = Math.max(...series, 0.01), w = 600, h = 96;
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * w},${h - (v / max) * (h - 8) - 4}`);
  const now = Date.now();
  return (
    <div className="flex flex-col gap-2 flex-1 min-h-[110px]">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full flex-1 min-h-0" aria-hidden>
        <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--color-up)" stopOpacity=".28" /><stop offset="1" stopColor="var(--color-up)" stopOpacity="0" /></linearGradient></defs>
        <path d={`M${pts.join(' L')} L${w},${h} L0,${h} Z`} fill="url(#sg)" />
        <path d={`M${pts.join(' L')}`} fill="none" stroke="var(--color-up)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between kicker">{[29, 20, 10].map((d) => <span key={d}>{day(now - d * DAY)}</span>)}<span>Today</span></div>
    </div>
  );
}

const Count = ({ n }: { n: number }) => <Counter value={n} format={(v) => count(Math.round(v))} />;

export function Home() {
  const { data: d, isLoading, error } = useOverview();
  const act = useMore(d?.activity ?? [], 15);
  if (error) return <Page title="Home"><div className="card"><Empty icon="alert" title="Can't reach Snip" text="The worker on the PC seems to be off. Start it and this page reloads by itself." /></div></Page>;
  if (isLoading || !d) return <Page title="Home"><Skeleton className="h-72" /><div className="grid grid-cols-3 gap-6 flex-1">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-64" />)}</div></Page>;

  const f = fee(), trend = d.viewsPrevWeek > 0 ? Math.round(((d.viewsWeek - d.viewsPrevWeek) / d.viewsPrevWeek) * 100) : null;
  const running = d.campaigns.filter((c) => c.open).length;
  const groups: [string, string, number][] = [['Running', 'var(--color-a)', running], ['Ending soon', 'var(--color-warn)', d.endingSoon.length], ['Can join', 'var(--color-up)', d.canJoin]];
  return (
    <Page kicker={d.paused ? 'Paused · nothing gets made' : new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })} title="Home" right={<Currency />}>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_minmax(0,560px)] gap-6 shrink-0">
        <section className="flex flex-col gap-4 min-w-0">
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div className="flex flex-col gap-2">
              <span className="kicker">Earned · all platforms</span>
              <span className={`text-[56px] md:text-[72px] font-bold tracking-[-0.04em] leading-none num ${d.earned > 0 ? '' : 'text-m'}`}><Counter value={d.earned} format={(n) => money(n, true)} /></span>
              <span className="text-sm text-m">{f > 0 ? <>After {f}% payout fee <b className="text-t">{money(d.earned * (1 - f / 100), true)}</b></>
                : d.posted ? `From ${count(d.posted)} posted clip${d.posted === 1 ? '' : 's'}` : 'Nothing posted yet. Keep a clip to get started.'}</span>
            </div>
            {d.earnedWeek > 0 ? <span className="pill !text-up !border-up/30 bg-up/10"><Icon name="up" size={14} />+{money(d.earnedWeek)} this week</span> : null}
          </div>
          <Spark series={d.earnedSeries} />
          <div className="grid grid-cols-3 gap-4">
            <a className="btn btn-1" href="#/review"><Icon name="play" />Review {d.toReview} clip{d.toReview === 1 ? '' : 's'}</a>
            <a className="btn" href="#/campaigns"><Icon name="flag" />Campaigns</a>
            <a className="btn" href="#/history"><Icon name="clock" />History</a>
          </div>
        </section>
        <div className="grid grid-cols-2 gap-4 auto-rows-[minmax(104px,auto)]">
          <Tile label="Views this week"><Count n={d.viewsWeek} />{trend != null ? <span className={`text-sm font-semibold ml-2 ${trend >= 0 ? 'text-up' : 'text-down'}`}>{trend >= 0 ? '+' : ''}{trend}%</span> : null}</Tile>
          <Tile label="Clips posted"><Count n={d.posted} /></Tile>
          <Tile label="Kept"><Count n={d.kept} /></Tile>
          <Tile label="Skipped"><Count n={d.skipped} /></Tile>
          <a href="#/review" className="card col-span-2 flex gap-4 items-center no-underline hover:border-white/15 transition-colors">
            <span className="flex gap-2 shrink-0">{d.reviewIds.length ? d.reviewIds.slice(0, 3).map((id) => (
              <video key={id} src={`/clip/${id}.mp4#t=1`} preload="metadata" muted playsInline className="w-12 h-[84px] rounded-lg bg-r object-cover" aria-hidden />))
              : <span className="w-12 h-[84px] rounded-lg bg-r flex items-center justify-center text-f"><Icon name="check" /></span>}</span>
            <span className="flex flex-col gap-1 min-w-0 flex-1">
              <span className="text-[17px] font-semibold"><Count n={d.toReview} /> clip{d.toReview === 1 ? '' : 's'} waiting</span>
              <span className="text-sm text-m truncate">{d.reviewFrom.length ? `From ${d.reviewFrom.join(' and ')}` : 'All caught up'}</span>
            </span>
            <Icon name="next" className="text-f" />
          </a>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1.3fr] gap-6 md:flex-1 md:min-h-0">
        <ListCard title="Campaigns" right={<a href="#/campaigns" className="text-sm font-semibold no-underline text-a">See all</a>}>
          {groups.map(([label, color, n]) => (
            <a key={label} href="#/campaigns" className="flex items-center gap-3 h-14 no-underline border-b border-line last:border-0 hover:text-a transition-colors">
              <span className="dot" style={{ background: color }} /><span className="flex-1 font-medium">{label}</span><span className="num font-semibold">{n}</span><Icon name="next" size={14} className="text-f" />
            </a>))}
        </ListCard>
        <ListCard title="Ending soon" right={<span className="kicker">Post before</span>}>
          {d.endingSoon.length ? d.endingSoon.map((c: Campaign) => (
            <a key={c.name} href={`#/campaigns/${c.name}`} className="flex items-center gap-3 h-16 no-underline border-b border-line last:border-0">
              <span className="w-8 h-8 rounded-full bg-r flex items-center justify-center text-xs font-semibold uppercase shrink-0">{c.name[0]}</span>
              <span className="flex-1 min-w-0 flex flex-col gap-2">
                <span className="flex justify-between gap-2 text-sm"><span className="font-semibold truncate">{c.name}</span><span className={`num ${c.daysLeft <= 2 ? 'text-warn' : 'text-m'}`}>{c.daysLeft <= 1 ? 'Last day' : `${c.daysLeft} days left`}</span></span>
                {/* bar = how much of the last week is gone */}
                <span className="h-1 rounded bg-r overflow-hidden"><span className="block h-full bg-warn rounded" style={{ width: `${Math.min(100, Math.max(6, ((7 - c.daysLeft) / 7) * 100))}%` }} /></span>
              </span>
            </a>))
            : <Empty icon="clock" title="Nothing ending this week" text="Campaigns that end within 7 days show up here." />}
        </ListCard>
        <ListCard title="Activity" right={<a href="#/history" className="text-sm font-semibold no-underline text-a">History</a>} footer={act.footer}>
          {/* stable key: a new item slides in on the 15 s refetch, the rest moves down (initial={false}: no animation on first load) */}
          {act.shown.length ? <AnimatePresence initial={false}>{act.shown.map((a) => (
            <motion.div key={`${a.kind}-${a.at}-${a.text}`} layout="position" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }} className="flex items-center gap-3 min-h-14 py-2 border-b border-line last:border-0 text-sm">
              <span className="w-8 h-8 rounded-lg bg-r flex items-center justify-center shrink-0"><Icon name={ACT[a.kind][0]} size={16} className={ACT[a.kind][1]} /></span>
              <span className="flex-1 min-w-0">{a.text}</span><span className="text-f text-xs whitespace-nowrap">{ago(a.at)}</span>
            </motion.div>
          ))}</AnimatePresence> : <Empty icon="clock" title="No activity yet" text="New clips, keeps and posts show up here." />}
          {act.sentinel}
        </ListCard>
      </div>
    </Page>
  );
}

