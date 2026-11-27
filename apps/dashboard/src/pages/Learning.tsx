import { type Learning as L, type LearningKind, useLearning } from '../api.ts';
import { Icon, Page, Skeleton } from '../ui.tsx';

const SIGNAL: Record<string, string> = { laughMax: 'Laughing', cheerMax: 'Cheering', speech: 'What is said', visual: 'What you see' };
const ago = (at: string | null) => {
  if (!at) return 'never';
  const h = Math.round((Date.now() - Date.parse(at)) / 3_600_000);
  return h < 1 ? 'less than an hour ago' : h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
};

function Bar({ label, done, total }: { label: string; done: number; total: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-sm"><span>{label}</span><span className="num text-m">{Math.min(done, total)} of {total}</span></div>
      <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(done, total)}>
        <i style={{ width: `${Math.min(100, (done / (total || 1)) * 100)}%`, transition: 'width .4s ease-out' }} />
      </div>
    </div>
  );
}

/** What runs right now: the daily Shorts study writes its step; campaign studies only show as a running job. */
function Now({ d }: { d: L }) {
  const n = d.now, campaign = d.running.includes('campaign.study');
  const title = n ? n.what : campaign ? 'Studying a campaign streamer' : d.queued.length ? 'Waiting to start' : 'Not training right now';
  const text = n ? `${n.step}${n.total ? `: ${n.done} of ${n.total} Shorts` : ''}.`
    : campaign ? 'Downloading the streamer\'s most viewed clips to learn what their viewers like.'
    : d.queued.length ? 'A study is in the queue. It starts when the jobs before it are done.'
    : 'Snip studies popular Shorts once a day, and a new campaign streamer\'s past clips when you join.';
  const on = !!n || campaign;
  return (
    <section className="card flex flex-col gap-3" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className={`dot ${on ? 'pulse' : ''}`} style={{ width: 10, height: 10, borderRadius: 5, background: on ? 'var(--color-a)' : 'var(--color-f)' }} />
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      <p className="text-sm text-m">{text}</p>
      {n?.total ? <Bar label="Progress" done={n.done} total={n.total} /> : null}
      {d.studies.map((s) => <Bar key={s.name} label={`${s.name}: past clips studied`} done={s.done} total={s.total} />)}
    </section>
  );
}

function Kind({ k }: { k: LearningKind }) {
  const ready = k.top >= k.need && k.flop >= k.need;
  return (
    <section className="card flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1 min-w-0">
          <h2 className="text-lg font-semibold">{k.label}</h2>
          <p className="text-sm text-m">Compares popular Shorts with weak Shorts from the same channels. Last study {ago(k.last)}.</p>
        </div>
        <span className="kicker shrink-0">{ready ? 'In use' : 'Collecting'}</span>
      </div>
      {ready ? (
        k.works.length || k.weak.length ? (
          <div className="flex flex-col gap-3">
            {k.works.length ? <div className="flex flex-col gap-1.5"><p className="kicker">Popular Shorts have more often</p>
              <ul className="flex flex-col gap-1.5">{k.works.map((l) => <li key={l} className="text-sm flex gap-2"><Icon name="up" size={16} className="shrink-0 mt-0.5 text-up" />{l}</li>)}</ul></div> : null}
            {k.weak.length ? <div className="flex flex-col gap-1.5"><p className="kicker">Weak Shorts have more often</p>
              <ul className="flex flex-col gap-1.5">{k.weak.map((l) => <li key={l} className="text-sm flex gap-2"><Icon name="alert" size={16} className="shrink-0 mt-0.5" />{l}</li>)}</ul></div> : null}
            <p className="text-sm text-m">The judge reads this when it rates new {k.kind === 'gaming' ? 'stream clips. Which moments get cut still comes from viewer clips and chat' : `${k.label.toLowerCase()} clips`}.</p>
          </div>
        ) : <p className="text-sm text-m">Enough Shorts studied, but no clear difference yet between popular and weak ones.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <Bar label="Popular Shorts" done={k.top} total={k.need} />
          <Bar label="Weak Shorts" done={k.flop} total={k.need} />
          <p className="text-sm text-m">Needs {k.need} of each before it trusts a pattern. Until then the judge works without hints.</p>
        </div>
      )}
    </section>
  );
}

function Weights({ w }: { w: L['weights'] }) {
  const ws = Object.entries(w.weights);
  return (
    <section className="card flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">How the judge's scores count</h2>
        <p className="text-sm text-m">{w.label ? `Learns from ${w.label}, last updated ${ago(w.at)}.` : 'Learns from your Keep and Skip choices and, later, real views.'}</p>
      </div>
      {w.n < w.need ? <Bar label="Rated clips" done={w.n} total={w.need} /> : null}
      {ws.length ? <ul className="grid grid-cols-2 gap-2">{ws.map(([k, v]) => <li key={k} className="flex justify-between text-sm p-3 rounded-xl bg-r"><span>{SIGNAL[k] ?? k}</span><span className="num">×{v}</span></li>)}</ul>
        : <p className="text-sm text-m">Needs {w.need} rated clips before it changes anything. Every clip counts the same until then.</p>}
    </section>
  );
}

/** Training page: what runs now and what Snip has learned so far, per kind of clip. */
export function Learning() {
  const { data } = useLearning();
  if (!data) return <Page title="Training"><div className="flex flex-col gap-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-40" />)}</div></Page>;
  return (
    <Page kicker="What Snip is learning" title="Training">
      <div className="scroll flex-1 min-h-0 -mr-2 pr-2">
        <div className="flex flex-col gap-4 pb-6">
          <Now d={data} />
          <div className="grid grid-cols-1 2xl:grid-cols-3 gap-4 content-start">{data.kinds.map((k) => <Kind key={k.kind} k={k} />)}</div>
          <Weights w={data.weights} />
        </div>
      </div>
    </Page>
  );
}
