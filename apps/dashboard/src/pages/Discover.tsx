import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { ago, money, PLATFORM, post, useDiscover, type DiscoverCampaign } from '../api.ts';
import { Empty, Icon, Page, Skeleton, useToast } from '../ui.tsx';

const JOINED = 'Already joined';
const FILTERS: [string, (c: DiscoverCampaign) => boolean][] = [['Can join', (c) => !c.why], ['Joined', (c) => c.why === JOINED], ['All', () => true]];
const rate = (p: DiscoverCampaign['pays'][number], pool: boolean) => pool ? 'Share of pool' : `${money(p.ratePer1k)} per 1K${p.maxPerClip ? ` · max ${money(p.maxPerClip)}` : ''}`;

/** Every Content Rewards campaign from the last look. Joinable ones get a Join button; the rest say in plain words why not. */
export function Discover() {
  const { data, isLoading } = useDiscover(), qc = useQueryClient(), toast = useToast();
  const [f, setF] = useState(0), [busy, setBusy] = useState(false);
  const all = data?.campaigns ?? [];
  const rows = all.filter(FILTERS[f][1]);
  const n = (i: number) => all.filter(FILTERS[i][1]).length;

  // One toast when a join this page started finishes.
  const watching = useRef(new Set<string>());
  useEffect(() => {
    for (const c of all) {
      if (c.joining) { watching.current.add(c.id); continue; }
      if (!watching.current.delete(c.id)) continue;
      if (c.why === JOINED) { toast({ text: `Joined ${c.name}. Studying top clips now.`, tone: 'up' }); qc.invalidateQueries({ queryKey: ['campaigns'] }); }
      else toast({ text: `Could not join ${c.name}`, tone: 'down' });
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const scan = async () => {
    setBusy(true);
    try { await post('/discover/scan'); toast({ text: 'Looking through Content Rewards. This takes a few minutes.', tone: 'info' }); await qc.invalidateQueries({ queryKey: ['discover'] }); }
    catch { toast({ text: 'That did not work. Try again.', tone: 'info' }); }
    setBusy(false);
  };
  const join = async (c: DiscoverCampaign) => {
    try { await post(`/discover/${c.id}/join`); watching.current.add(c.id); toast({ text: `Joining ${c.name}…`, tone: 'info' }); await qc.invalidateQueries({ queryKey: ['discover'] }); }
    catch { toast({ text: 'That did not work. Try again.', tone: 'info' }); }
  };

  const scanning = Boolean(data?.scanning || busy);
  return (
    <Page back={<a href="#/campaigns" className="text-sm text-m no-underline flex items-center gap-1 w-fit hover:text-t transition-colors"><Icon name="back" size={16} />Campaigns</a>}
      kicker={data?.at ? `Last looked ${ago(Date.parse(data.at))} · ${n(0)} you can join` : 'Content Rewards'} title="Discover campaigns"
      right={<button className="btn btn-1" onClick={scan} disabled={scanning} aria-busy={scanning}>{scanning ? <span className="spin" aria-hidden /> : <Icon name="search" size={16} />}{scanning ? 'Looking…' : 'Look for campaigns'}</button>}>
      {data?.scanError && !scanning ? <p className="card !py-3 text-sm text-warn m-0 shrink-0 flex items-center gap-2" role="alert"><Icon name="alert" size={16} />The last look failed. Is the Content Rewards Chrome open and logged in?</p> : null}
      <div className="segs shrink-0 self-start" role="group" aria-label="Filter">{FILTERS.map(([l], i) => <button key={l} className="seg" aria-pressed={f === i} onClick={() => setF(i)}>{l} <span className="num text-f">{data ? n(i) : ''}</span></button>)}</div>
      {isLoading ? <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-48" />)}</div>
        : !rows.length ? <div className="card flex flex-1"><Empty icon="search" title={data?.at ? 'Nothing here' : 'No campaigns yet'}
          text={data?.at ? 'No campaigns match this filter. New ones show up every day.' : 'Press "Look for campaigns". Snip opens Content Rewards like a person would and lists everything.'} /></div>
        : <div className="scroll flex-1 min-h-0 -mr-2 pr-2"><div className="grid md:grid-cols-2 xl:grid-cols-3 min-[2200px]:grid-cols-4 gap-4 content-start pb-6">
          <AnimatePresence initial={false}>{rows.map((c) => <Card key={c.id} c={c} onJoin={() => join(c)} />)}</AnimatePresence>
        </div></div>}
    </Page>
  );
}

function Card({ c, onJoin }: { c: DiscoverCampaign; onJoin: () => void }) {
  const leftPct = c.budget ? Math.max(0, Math.min(100, (c.left / c.budget) * 100)) : 0;
  return (
    <motion.section layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
      className={`card flex flex-col gap-4 ${c.why && c.why !== JOINED ? 'opacity-75' : ''}`}>
      <div className="flex items-start gap-3">
        <span className="av !w-10 !h-10 !rounded-[12px] !text-sm" aria-hidden>{(c.streamer ?? c.name)[0].toUpperCase()}</span>
        <div className="flex flex-col min-w-0 flex-1"><span className="font-semibold leading-snug line-clamp-2">{c.name}</span>
          <span className="text-sm text-m truncate">{c.streamer ? `twitch.tv/${c.streamer}` : 'No Twitch channel'}{c.org ? ` · ${c.org}` : ''}</span></div>
      </div>
      <ul className="flex flex-col gap-1.5 m-0 p-0 list-none text-sm">
        {c.pays.length ? c.pays.map((p) => <li key={p.platform} className="flex justify-between gap-3"><span className="text-m">{PLATFORM[p.platform] ?? p.platform}</span><span className="num">{rate(p, c.pool)}</span></li>)
          : <li className="text-m">No paying platform listed</li>}
      </ul>
      <div className="flex flex-col gap-1.5 mt-auto">
        <div className="flex justify-between text-[13px]"><span className="text-m">{c.pool ? 'Pool' : 'Budget'} left</span><span className="num">{money(c.left)} of {money(c.budget)}</span></div>
        <div className="bar" role="progressbar" aria-valuenow={Math.round(leftPct)} aria-valuemin={0} aria-valuemax={100} aria-label="Budget left"><i style={{ width: `${leftPct}%`, background: leftPct < 15 ? 'var(--color-warn)' : undefined }} /></div>
      </div>
      {c.joinError && !c.joining && c.why !== JOINED ? <p className="text-[13px] text-warn m-0">Last try failed: {c.joinError.replace(/^Error:\s*/, '').slice(0, 140)}</p> : null}
      {c.why === JOINED ? <a href={c.streamer ? `#/campaigns/${c.streamer}` : '#/campaigns'} className="btn no-underline"><Icon name="check" size={16} />Joined · open campaign</a>
        : c.why ? <span className="pill self-start"><span className="dot" style={{ background: 'var(--color-f)' }} />{c.why}</span>
        : <button className="btn btn-1" onClick={onJoin} disabled={c.joining} aria-busy={c.joining}>{c.joining ? <><span className="spin" aria-hidden />Joining…</> : <><Icon name="plus" size={16} />Join</>}</button>}
    </motion.section>
  );
}
