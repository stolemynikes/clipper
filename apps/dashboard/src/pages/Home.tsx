import type { ReactNode } from 'react';
import { ago, count, money, useOverview, type Activity, type Campaign } from '../api.ts';
import { Counter, Empty, Icon, Page, Skeleton, Stat, useMore } from '../ui.tsx';

const ACT: Record<Activity['kind'], [string, string]> = { new: ['scissors', 'text-a'], kept: ['check', 'text-up'], skipped: ['x', 'text-down'], posted: ['upload', 'text-a'] };

function ListCard({ title, right, children, footer }: { title: string; right?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="card !p-0 flex flex-col min-h-[280px] md:min-h-0">
      <div className="flex items-center justify-between h-14 px-5 shrink-0 border-b border-line"><h2 className="text-[17px] font-semibold m-0">{title}</h2>{right}</div>
      <div className="scroll flex-1 min-h-0 flex flex-col">{children}</div>
      {footer}
    </section>
  );
}

const CampRow = ({ c, right }: { c: Campaign; right: ReactNode }) => (
  <a href={`#/campaigns/${c.name}`} className="flex items-center gap-3 h-14 px-5 no-underline hover:bg-white/[.02] transition-colors border-b border-line last:border-0">
    <span className="w-8 h-8 rounded-full bg-r flex items-center justify-center text-xs font-semibold uppercase">{c.name.slice(0, 2)}</span>
    <span className="flex-1 min-w-0 truncate font-medium">{c.name}</span>{right}
  </a>
);

export function Home() {
  const { data: d, isLoading, error } = useOverview();
  const act = useMore(d?.activity ?? [], 15);
  if (error) return <Page title="Home"><div className="card"><Empty icon="alert" title="Can't reach Snip" text="The worker on the PC seems to be off. Start it and this page reloads by itself." /></div></Page>;
  if (isLoading || !d) return <Page title="Home"><Skeleton className="h-40" /><div className="grid grid-cols-2 md:grid-cols-4 gap-4">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24" />)}</div></Page>;

  return (
    <Page kicker={d.paused ? 'Paused · nothing gets made' : new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} title="Home">
      <div className="flex flex-col md:flex-row gap-6 shrink-0">
        <section className="card flex-1 flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <span className="text-sm text-m">Earned so far</span>
            <span className={`text-[44px] md:text-[56px] font-semibold leading-none ${d.earned > 0 ? 'text-up' : ''}`}><Counter value={d.earned} format={money} /></span>
            <span className="text-sm text-f">{d.posted ? `From ${count(d.posted)} posted clip${d.posted === 1 ? '' : 's'}` : 'Nothing posted yet. Keep a clip to get started.'}</span>
          </div>
          <div className="flex flex-wrap gap-3">
            <a className="btn btn-1" href="#/review"><Icon name="play" />Review {d.toReview} clip{d.toReview === 1 ? '' : 's'}</a>
            <a className="btn" href="#/campaigns">Campaigns</a>
            <a className="btn" href="#/history">History</a>
          </div>
        </section>
        <a href="#/review" className="card md:w-[340px] flex gap-4 items-center no-underline hover:border-white/15 transition-colors">
          <span className="w-12 h-12 rounded-2xl bg-p/15 text-a flex items-center justify-center"><Icon name="play" size={22} /></span>
          <span className="flex flex-col gap-1 min-w-0 flex-1">
            <span className="text-[17px] font-semibold"><Counter value={d.toReview} format={(n) => count(Math.round(n))} /> clip{d.toReview === 1 ? '' : 's'} waiting</span>
            <span className="text-sm text-f truncate">{d.reviewFrom.length ? `From ${d.reviewFrom.join(', ')}` : 'All caught up'}</span>
          </span>
          <Icon name="next" className="text-f" />
        </a>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 shrink-0">
        <Stat label="Views"><Counter value={d.views} format={(n) => count(Math.round(n))} /></Stat>
        <Stat label="Clips posted" sub={`${d.postedThisWeek} this week`}><Counter value={d.posted} format={(n) => count(Math.round(n))} /></Stat>
        <Stat label="Kept"><Counter value={d.kept} format={(n) => count(Math.round(n))} /></Stat>
        <Stat label="Skipped"><Counter value={d.skipped} format={(n) => count(Math.round(n))} /></Stat>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1.3fr] gap-6 md:flex-1 md:min-h-0">
        <ListCard title="Campaigns" right={<a href="#/campaigns" className="text-sm font-semibold no-underline text-a">All</a>}>
          {d.campaigns.length ? d.campaigns.map((c) => <CampRow key={c.name} c={c} right={<span className="pill">{c.status}</span>} />)
            : <Empty icon="flag" title="No campaigns running" text={d.canJoin ? `${d.canJoin} can be joined.` : 'Add one on the campaigns page.'} />}
        </ListCard>
        <ListCard title="Ending soon">
          {d.endingSoon.length ? d.endingSoon.map((c) => <CampRow key={c.name} c={c} right={<span className={`text-sm num ${c.daysLeft <= 2 ? 'text-warn' : 'text-m'}`}>{c.daysLeft === 1 ? 'Last day' : `${c.daysLeft} days left`}</span>} />)
            : <Empty icon="clock" title="Nothing ending this week" text="Campaigns that end within 7 days show up here." />}
        </ListCard>
        <ListCard title="Activity" footer={act.footer}>
          {act.shown.length ? act.shown.map((a, i) => (
            <div key={i} className="flex items-center gap-3 min-h-12 px-5 py-2 border-b border-line last:border-0 text-sm">
              <Icon name={ACT[a.kind][0]} className={ACT[a.kind][1]} /><span className="flex-1 min-w-0">{a.text}</span><span className="text-f text-xs whitespace-nowrap">{ago(a.at)}</span>
            </div>
          )) : <Empty icon="clock" title="No activity yet" text="New clips, keeps and posts show up here." />}
          {act.sentinel}
        </ListCard>
      </div>
    </Page>
  );
}
