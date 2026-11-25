import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { ago, PLATFORM, post, useReview, type ReviewClip } from '../api.ts';
import { Empty, Icon, Page, Skeleton, useToast } from '../ui.tsx';

const why = (r: string) => /clipped/.test(r) ? 'scissors' : /[Cc]hat/.test(r) ? 'chat' : /laugh|emote/i.test(r) ? 'smile' : /loud|volume|scream/i.test(r) ? 'volume' : /lower|website|away/i.test(r) ? 'alert' : 'check';
const strength = (n: number) => n >= 8 ? ['Strong moment', 'text-up'] : n >= 5 ? ['Good moment', 'text-a'] : ['Weak moment', 'text-warn'];

function Checks({ c }: { c: ReviewClip }) {
  const rows: [boolean, string][] = [
    [c.maxSec == null || c.seconds <= c.maxSec, c.maxSec ? `${c.seconds} seconds, limit is ${c.maxSec}` : `${c.seconds} seconds long`],
    [Boolean(c.tag), c.tag ? `Tags ${c.tag}` : 'No streamer tag set'],
    ...c.warnings.map((w): [boolean, string] => [false, w]),
  ];
  return (
    <section className="card flex flex-col gap-3">
      <h2 className="text-[17px] font-semibold m-0">Campaign rules</h2>
      {rows.map(([ok, t], i) => <div key={i} className="flex items-start gap-3 text-sm"><Icon name={ok ? 'check' : 'alert'} className={ok ? 'text-up mt-px' : 'text-warn mt-px'} /><span className={ok ? 'text-m' : ''}>{t}</span></div>)}
    </section>
  );
}

export function Review({ focus }: { focus?: number }) {
  const { data, isLoading, error } = useReview();
  const qc = useQueryClient(), toast = useToast();
  const [busy, setBusy] = useState(false), [gone, setGone] = useState<number[]>([]);
  const list = (data ?? []).filter((c) => !gone.includes(c.id)).sort((a, b) => Number(b.id === focus) - Number(a.id === focus));
  const c = list[0];

  const decide = useCallback(async (keep: boolean) => {
    if (!c || busy) return;
    setBusy(true);
    try {
      await post(`/clip/${c.id}/${keep ? 'approve' : 'reject'}`);
      setGone((g) => [...g, c.id]);
      toast({ text: keep ? `Kept ${c.streamer} clip. It goes out next.` : `Skipped ${c.streamer} clip`, tone: keep ? 'up' : 'down' });
      qc.invalidateQueries({ queryKey: ['overview'] });
    } catch { toast({ text: 'That did not work. Try again.', tone: 'info' }); }
    finally { setBusy(false); }
  }, [c, busy, qc, toast]);

  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'k' || e.key === 'K') decide(true);
      if (e.key === 's' || e.key === 'S') decide(false);
    };
    addEventListener('keydown', f);
    return () => removeEventListener('keydown', f);
  }, [decide]);

  if (error) return <Page title="Review"><div className="card"><Empty icon="alert" title="Can't load clips" text="The worker on the PC seems to be off." /></div></Page>;
  if (isLoading) return <Page title="Review"><div className="flex gap-6"><Skeleton className="w-[396px] h-[704px] max-h-[70vh]" /><Skeleton className="flex-1 h-96" /></div></Page>;
  if (!c) return <Page title="Review"><div className="card flex flex-1"><Empty icon="check" title="All caught up" text="New clips show up here by themselves. Snip sends a ping when there are more." /></div></Page>;

  const [sLabel, sTone] = strength(c.strength), total = gone.length + list.length;
  return (
    <Page kicker={`Clip ${gone.length + 1} of ${total} · ${c.streamer} · ${ago(c.at)}`} title={c.title ?? `${c.streamer} clip`}>
      <div className="flex flex-col md:flex-row gap-6 md:flex-1 md:min-h-0">
        <div className="flex flex-col gap-4 md:w-[396px] shrink-0 md:min-h-0">
          <AnimatePresence mode="wait">
            <motion.video key={c.id} src={`/clip/${c.id}.mp4`} controls playsInline autoPlay preload="metadata"
              initial={{ opacity: 0, scale: .98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, transition: { duration: .12 } }}
              className="w-full aspect-[9/16] md:h-auto md:max-h-[calc(100vh-260px)] rounded-[20px] bg-black object-contain border border-line" />
          </AnimatePresence>
          {list.length > 1 ? (
            <div className="hidden md:flex flex-col gap-2 min-h-0">
              <span className="kicker">Up next · {list.length - 1}</span>
              <div className="scroll flex flex-col gap-1">{list.slice(1, 6).map((n) => <div key={n.id} className="flex justify-between text-sm text-m h-8 items-center"><span className="truncate">{n.streamer} · {n.title ?? 'Untitled'}</span><span className="text-f num">{n.seconds}s</span></div>)}</div>
            </div>
          ) : null}
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-4 md:scroll md:min-h-0">
          {c.hook ? <div className="text-m text-sm">On screen: <span className="text-t font-medium">{c.hook}</span></div> : null}
          <section className="card flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3"><h2 className="text-[17px] font-semibold m-0">Why Snip picked this</h2><span className={`pill ${sTone}`}>{sLabel}</span></div>
            {c.reasons.map((r) => <div key={r} className="flex items-center gap-3 text-sm"><span className="w-8 h-8 rounded-xl bg-r flex items-center justify-center text-a"><Icon name={why(r)} size={16} /></span>{r}</div>)}
            <a href={c.source} target="_blank" rel="noreferrer" className="text-sm text-a no-underline flex items-center gap-2 w-fit"><Icon name="link" size={14} />Watch it in the stream</a>
          </section>
          <Checks c={c} />
          <section className="card flex flex-col gap-3">
            <h2 className="text-[17px] font-semibold m-0">Will post to</h2>
            <div className="flex flex-wrap gap-2">{c.platforms.length ? c.platforms.map((p) => <span key={p} className="pill">{PLATFORM[p] ?? p}</span>) : <span className="text-sm text-f">No platforms in the campaign rules</span>}</div>
          </section>
          <div className="grid grid-cols-2 gap-3 mt-auto sticky bottom-24 md:static">
            <button className="btn big" disabled={busy} onClick={() => decide(false)}><Icon name="x" />Skip <span className="kbd hidden md:inline">S</span></button>
            <button className="btn btn-1 big" disabled={busy} onClick={() => decide(true)}><Icon name="check" />Keep and post <span className="kbd hidden md:inline">K</span></button>
          </div>
        </div>
      </div>
    </Page>
  );
}
