import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ago, count, money, PLATFORM, post, useCampaign, useCampaigns, type Campaign } from '../api.ts';
import { Counter, Empty, Icon, Page, Skeleton, Stat, useMore, useToast } from '../ui.tsx';

const FILTERS: [string, (c: Campaign) => boolean][] = [['All', () => true], ['Running', (c) => c.on], ['Can join', (c) => c.open && !c.on], ['Ended', (c) => !c.open]];
const tone = (c: Campaign) => !c.open ? 'var(--color-f)' : /making/i.test(c.status) ? 'var(--color-up)' : c.on ? 'var(--color-a)' : 'var(--color-warn)';
const ends = (c: Campaign) => !c.open ? 'Ended' : c.daysLeft === 1 ? 'Last day' : `${c.daysLeft} days`;
const pay = (c: Campaign) => c.pool ? `${money(c.pool)} pool` : c.ratePer1k ? `${money(c.ratePer1k)} per 1K` : '—';

export function Campaigns() {
  const { data, isLoading } = useCampaigns();
  const [f, setF] = useState(0), [q, setQ] = useState('');
  const rows = (data ?? []).filter(FILTERS[f][1]).filter((c) => c.name.includes(q.trim().toLowerCase())).sort((a, b) => Number(b.on) - Number(a.on) || Number(b.open) - Number(a.open) || a.daysLeft - b.daysLeft);
  const more = useMore(rows, 25);
  const n = (i: number) => (data ?? []).filter(FILTERS[i][1]).length;
  const running = n(1), join = n(2);

  return (
    <Page kicker={`${running} running · ${join} to join`} title="Campaigns">
      <div className="flex flex-wrap gap-3 items-center shrink-0">
        <input className="field w-[280px] max-w-full" type="search" placeholder="Search streamers" aria-label="Search streamers" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="segs" role="group" aria-label="Filter">{FILTERS.map(([l], i) => <button key={l} className="seg" aria-pressed={f === i} onClick={() => setF(i)}>{l} <span className="num text-f">{data ? n(i) : ''}</span></button>)}</div>
      </div>
      <section className="card !p-0 flex flex-col md:flex-1 md:min-h-0 overflow-hidden">
        {isLoading ? <div className="p-5 flex flex-col gap-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          : !rows.length ? <Empty icon="flag" title="Nothing here" text="No campaigns match this filter." />
          : <div className="scroll flex-1 min-h-0">
            <table className="tbl">
              <thead><tr><th>Streamer</th><th className="hidden lg:table-cell">Platform</th><th className="hidden md:table-cell">Pays</th><th className="r hidden md:table-cell">Your views</th><th className="r">Earned</th><th className="hidden md:table-cell">Time left</th><th>Status</th><th aria-hidden /></tr></thead>
              <tbody>{more.shown.map((c) => (
                <tr key={c.name} className="cursor-pointer" onClick={() => { location.hash = `#/campaigns/${c.name}`; }}>
                  <td><a href={`#/campaigns/${c.name}`} className="no-underline font-medium flex items-center gap-3"><span className="av" aria-hidden>{c.name[0].toUpperCase()}</span>{c.name}</a></td>
                  <td className="hidden lg:table-cell text-m capitalize">{c.site.replace(/_/g, ' ')}</td>
                  <td className="hidden md:table-cell text-m num">{pay(c)}</td>
                  <td className="r hidden md:table-cell num">{count(c.views)}</td>
                  <td className={`r num font-semibold ${c.earned > 0 ? 'text-up' : 'text-m'}`}>{money(c.earned)}</td>
                  <td className="hidden md:table-cell w-[160px]"><div className="flex flex-col gap-1.5"><span className={`text-[13px] num ${c.open && c.daysLeft <= 2 ? 'text-warn' : 'text-m'}`}>{ends(c)}</span>
                    {/* shortcut: no start date stored, bar assumes a 30-day campaign */}
                    <div className="bar"><i style={{ width: `${c.open ? Math.min(100, (c.daysLeft / 30) * 100) : 0}%`, background: c.daysLeft <= 2 ? 'var(--color-warn)' : undefined }} /></div></div></td>
                  <td><span className="pill"><span className="dot" style={{ background: tone(c) }} />{c.status}</span></td>
                  <td className="r text-f w-8"><Icon name="next" size={16} /></td>
                </tr>))}
              </tbody>
            </table>
            {more.sentinel}
          </div>}
        {rows.length ? more.footer : null}
      </section>
      <p className="text-[13px] text-f m-0 shrink-0">Earned is an estimate from views. The campaign checks every clip before it pays.</p>
    </Page>
  );
}

export function CampaignPage({ name }: { name: string }) {
  const { data: c, isLoading, error } = useCampaign(name);
  const qc = useQueryClient(), toast = useToast(), [busy, setBusy] = useState(false);
  const clips = useMore(c?.clips ?? [], 25);
  const back = <a href="#/campaigns" className="text-sm text-m no-underline flex items-center gap-1 w-fit hover:text-t transition-colors"><Icon name="back" size={16} />Campaigns</a>;
  if (error) return <Page back={back} title="Not found"><div className="card"><Empty icon="flag" title="No such campaign" text={`There is no campaign for ${name}.`} /></div></Page>;
  if (isLoading || !c) return <Page back={back} title={name}><div className="grid grid-cols-2 md:grid-cols-4 gap-4">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24" />)}</div></Page>;

  const toggle = async () => {
    setBusy(true);
    try {
      await post(`/campaigns/${c.name}/${c.on ? 'off' : 'on'}`);
      toast({ text: c.on ? `Stopped making ${c.name} clips` : `Making ${c.name} clips again`, tone: c.on ? 'down' : 'up' });
      qc.invalidateQueries();
    } catch { toast({ text: 'That did not work. Try again.', tone: 'info' }); }
    finally { setBusy(false); }
  };
  const share = c.pool && c.earned ? `${((c.earned / c.pool) * 100).toFixed(1)}% of the pool` : undefined;

  return (
    <Page back={back} kicker={`${c.status} · ${ends(c)}${c.open ? ' left' : ''}`} title={c.name}
      right={<div className="flex gap-3">
        {c.url ? <a className="btn" href={c.url} target="_blank" rel="noreferrer"><Icon name="link" size={16} />Open brief</a> : null}
        {c.open ? <button className={`btn ${c.on ? '' : 'btn-1'}`} disabled={busy} onClick={toggle}>{c.on ? 'Stop clips' : 'Start clips'}</button> : null}
      </div>}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 shrink-0">
        <Stat label={c.pool ? 'Pool' : 'Pays'}>{c.pool ? money(c.pool) : c.ratePer1k ? `${money(c.ratePer1k)}/1K` : '—'}</Stat>
        <Stat label="Your views"><Counter value={c.views} format={(n) => count(Math.round(n))} /></Stat>
        <Stat label="Your clips" sub={`${c.clips.filter((x) => x.submitted).length} sent to the campaign`}><Counter value={c.posts} format={(n) => count(Math.round(n))} /></Stat>
        <Stat label="Earned so far" sub={share}><span className={c.earned > 0 ? 'text-up' : ''}><Counter value={c.earned} format={money} /></span></Stat>
      </div>
      <div className="flex flex-col md:flex-row gap-6 md:flex-1 md:min-h-0">
        <section className="card !p-0 flex flex-col flex-1 min-w-0 md:min-h-0 overflow-hidden">
          {c.clips.length ? <>
            <div className="scroll flex-1 min-h-0">
              <table className="tbl">
                <thead><tr><th>Your clips</th><th className="hidden md:table-cell">Posted on</th><th className="r">Views</th><th className="r">Earned</th></tr></thead>
                <tbody>{clips.shown.map((p) => (
                  <tr key={p.id}>
                    <td><div className="flex flex-col gap-1 min-w-0"><span className="font-medium truncate">{p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="no-underline">{p.title ?? 'Untitled'}</a> : p.title ?? 'Untitled'}</span><span className="text-xs text-f">{p.postedAt ? ago(p.postedAt) : 'Not posted yet'}{p.submitted ? ' · sent' : ''}</span></div></td>
                    <td className="hidden md:table-cell text-m">{p.platform}</td>
                    <td className="r num">{count(p.views)}</td>
                    <td className={`r num font-semibold ${p.earned > 0 ? 'text-up' : 'text-m'}`}>{money(p.earned)}</td>
                  </tr>))}
                </tbody>
              </table>
              {clips.sentinel}
            </div>{clips.footer}</>
            : <Empty icon="upload" title="No clips posted yet" text="Kept clips for this campaign show up here with their views." />}
        </section>
        <div className="md:w-[340px] shrink-0 flex flex-col gap-4 md:min-h-0">
          <section className="card flex flex-col gap-3 shrink-0">
            <h2 className="text-[17px] font-semibold m-0">Payout</h2>
            <Row k="How it pays" v={c.pool ? 'Share of the pool, by views' : 'Per 1,000 views'} />
            {c.ratePer1k ? <Row k="Per 1K views" v={money(c.ratePer1k)} /> : null}
            {c.maxPerClip ? <Row k="Max per clip" v={money(c.maxPerClip)} /> : null}
            <Row k="Ends" v={new Date(c.endsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} />
          </section>
          <section className="card flex flex-col gap-3 md:flex-1 md:min-h-0 scroll">
            <h2 className="text-[17px] font-semibold m-0">Rules</h2>
            <div className="flex flex-wrap gap-2">{c.platforms.map((p) => <span key={p} className="pill">{PLATFORM[p] ?? p}</span>)}</div>
            <Rule ok text={`Tag ${c.tag}`} />
            {c.disclosure ? <Rule ok text="#ad on every clip: Content Rewards rule (FTC), not from this brief" /> : null}
            {c.hashtags.length ? <Rule ok text={`Hashtags: ${c.hashtags.join(' ')}`} /> : null}
            {c.facts.map((f) => <Rule key={f} ok text={f} />)}
            {c.warnings.map((w) => <Rule key={w} text={w} />)}
          </section>
        </div>
      </div>
    </Page>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => <div className="flex justify-between gap-3 text-sm"><span className="text-m">{k}</span><span className="num font-medium text-right">{v}</span></div>;
const Rule = ({ ok, text }: { ok?: boolean; text: string }) => <div className="flex items-start gap-3 text-sm"><Icon name={ok ? 'check' : 'alert'} className={`mt-px ${ok ? 'text-up' : 'text-warn'}`} /><span className={ok ? 'text-m' : ''}>{text}</span></div>;
