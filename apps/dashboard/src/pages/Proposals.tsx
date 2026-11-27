import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { post, type Proposal, useProposals } from '../api.ts';
import { Empty, Icon, Page, Skeleton, useToast } from '../ui.tsx';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const STATUS: Record<Proposal['status'], string> = { testing: 'Testing', ready: 'Ready to decide', approved: 'Live', rejected: 'Rejected' };

/** One line per proposal, plain words: what the owner pastes to Claude. */
function summary(ps: Proposal[]) {
  return ps.map((p) => {
    const s = p.untested ? (p.evidence ?? 'from study, not tested') : p.score ? `wins ${p.score.wins} of ${p.score.n} (${pct(p.score.share)}, likely ${pct(p.score.low)}-${pct(p.score.high)})` : `${p.allPairs} of 20 tests`;
    const aa = p.aa.biased ? ', judge leans to one side: score not trusted' : p.aa.n ? `, judge check ${p.aa.n}x ok` : '';
    return `- ${p.title} [${STATUS[p.status]}]: ${s}${aa}`;
  }).join('\n');
}

function Score({ p }: { p: Proposal }) {
  if (p.untested) return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-m">{p.evidence ?? 'From study, not tested. The judge cannot rate this, so real views after posting will show if it helps.'}</p>
      {p.change.titleExamples?.length ? <ul className="text-sm flex flex-col gap-1 list-disc pl-5">{p.change.titleExamples.map((t) => <li key={t}>{t}</li>)}</ul> : null}
    </div>);
  if (!p.score) return <p className="text-sm text-m">{p.allPairs} of 20 tests done. The score shows after 20.</p>;
  const { wins, n, share, low, high } = p.score, unclear = low <= 0.5 && high >= 0.5;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-lg font-semibold">New version wins {wins % 1 ? wins.toFixed(1) : wins} of {n} ({pct(share)})</p>
      <p className="text-sm text-m">Probably between {pct(low)} and {pct(high)}. {unclear ? 'That includes 50%, so it could still be luck.' : share > 0.5 ? 'Clearly better than the current version.' : 'Clearly worse than the current version.'}</p>
    </div>
  );
}

function Card({ p }: { p: Proposal }) {
  const qc = useQueryClient(), toast = useToast(), [busy, setBusy] = useState(false);
  const act = async (ok: boolean) => {
    setBusy(true);
    try { await post(`/proposals/${p.id}/${ok ? 'approve' : 'reject'}`); toast({ text: ok ? 'Approved: new clips use this now' : 'Rejected', tone: ok ? 'up' : 'down' }); await qc.invalidateQueries({ queryKey: ['proposals'] }); }
    catch { toast({ text: 'That did not work. Try again.', tone: 'info' }); }
    finally { setBusy(false); }
  };
  const open = p.status === 'testing' || p.status === 'ready';
  return (
    <section className="card flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1 min-w-0"><h2 className="text-lg font-semibold">{p.title}</h2><p className="text-sm text-m">{p.why}</p></div>
        <span className="kicker shrink-0">{STATUS[p.status]}</span>
      </div>
      <Score p={p} />
      {p.aa.biased
        ? <p className="text-sm flex items-center gap-2"><Icon name="alert" size={16} /> The judge leans toward one side even when both clips are the same. Do not trust this score yet.</p>
        : p.aa.n ? <p className="text-sm text-m">Judge check: shown the same clip twice {p.aa.n} times, no lean found.</p> : null}
      {p.frames.length ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {p.frames.slice(0, 2).flatMap((f) => [['Now', f.old], ['New', f.new]].map(([label, file]) => (
            <figure key={file} className="flex flex-col gap-1">
              <img src={`/proposal-frame/${p.id}/${file}`} alt={`${label} version, practice clip ${f.clipId}`} loading="lazy" className="rounded-xl border border-line w-full aspect-[9/16] object-cover" />
              <figcaption className="kicker">{label}</figcaption>
            </figure>)))}
        </div>) : null}
      {open ? (
        <div className="flex gap-3">
          <button className="btn btn-1" disabled={busy} onClick={() => act(true)}><Icon name="check" size={16} /> Approve</button>
          <button className="btn" disabled={busy} onClick={() => act(false)}><Icon name="x" size={16} /> Reject</button>
        </div>) : null}
    </section>
  );
}

/** Night practice results: each proposal is one editing change, tested by comparing the same moment rendered both ways. */
export function Proposals() {
  const { data } = useProposals(), toast = useToast();
  if (!data) return <Page title="Proposals"><div className="flex flex-col gap-3">{[1, 2].map((i) => <Skeleton key={i} className="h-48" />)}</div></Page>;
  const order = { ready: 0, testing: 1, approved: 2, rejected: 3 };
  const ps = [...data].sort((a, b) => order[a.status] - order[b.status]);
  const copy = async () => { try { await navigator.clipboard.writeText(summary(ps)); toast({ text: 'Summary copied', tone: 'up' }); } catch { toast({ text: 'Copy failed', tone: 'info' }); } };
  return (
    <Page kicker="Learned from practice clips at night" title="Proposals" right={ps.length ? <button className="btn" onClick={copy}>Copy summary</button> : undefined}>
      {ps.length ? <div className="scroll flex-1 min-h-0 -mr-2 pr-2"><div className="grid grid-cols-1 2xl:grid-cols-2 gap-4 content-start pb-6">{ps.map((p) => <Card key={p.id} p={p} />)}</div></div>
        : <Empty icon="smile" title="No proposals yet" text="Turn on Practice at night in Settings. Proposals show up here the next morning." />}
    </Page>
  );
}
