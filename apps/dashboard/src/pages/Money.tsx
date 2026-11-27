import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, type FormEvent } from 'react';
import { count, money, post, useAccounts, useEarnings, useHistory, type Account, type Accounts as AccountsData, type AppSetup, type Month } from '../api.ts';
import { Counter, Currency, Empty, Icon, Page, Skeleton, Stat, useMore, useToast } from '../ui.tsx';

const Loading = ({ title }: { title: string }) => <Page title={title}><div className="grid grid-cols-2 md:grid-cols-3 gap-4">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div></Page>;
const Down = ({ title }: { title: string }) => <Page title={title}><div className="card"><Empty icon="alert" title="Can't load this" text="The worker on the PC seems to be off." /></div></Page>;
const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function Earnings() {
  const { data, isLoading, error } = useEarnings();
  const rows = useMore(data?.campaigns ?? [], 25), pays = useMore(data?.payouts ?? [], 25);
  if (error) return <Down title="Earnings" />;
  if (isLoading || !data) return <Loading title="Earnings" />;
  return (
    <Page kicker="Estimates come from views; paid is what campaigns sent" title="Earnings">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 shrink-0">
        <Stat label="Estimated so far" sub="From views, before the campaign checks them"><Counter value={data.estimated} format={money} /></Stat>
        <Stat label="Paid out"><span className={data.paid > 0 ? 'text-up' : ''}><Counter value={data.paid} format={money} /></span></Stat>
        <Stat label="Waiting for payment"><Counter value={data.pending} format={money} /></Stat>
      </div>
      <div className="flex flex-col md:flex-row gap-6 md:flex-1 md:min-h-0">
        <section className="card !p-0 flex flex-col flex-1 min-w-0 md:min-h-0 overflow-hidden">
          {data.campaigns.length ? <>
            <div className="scroll flex-1 min-h-0">
              <table className="tbl">
                <thead><tr><th>Campaign</th><th className="r hidden md:table-cell">Clips</th><th className="r hidden md:table-cell">Views</th><th className="r">Estimated</th><th className="r">Paid</th></tr></thead>
                <tbody>{rows.shown.map((c) => (
                  <tr key={c.name} className="cursor-pointer" onClick={() => { location.hash = `#/campaigns/${c.name}`; }}>
                    <td><a href={`#/campaigns/${c.name}`} className="no-underline font-medium">{c.name}</a></td>
                    <td className="r hidden md:table-cell num">{count(c.posts)}</td>
                    <td className="r hidden md:table-cell num">{count(c.views)}</td>
                    <td className="r num text-m">{money(c.earned)}</td>
                    <td className={`r num font-semibold ${c.paid > 0 ? 'text-up' : 'text-m'}`}>{money(c.paid)}</td>
                  </tr>))}
                </tbody>
              </table>
              {rows.sentinel}
            </div>{rows.footer}</>
            : <Empty icon="money" title="No earnings yet" text="This fills in once clips are posted and get views." />}
        </section>
        <section className="card flex flex-col gap-3 md:w-[340px] shrink-0 md:min-h-0 scroll">
          <h2 className="text-[17px] font-semibold m-0">Payments</h2>
          {data.payouts.length ? <>{pays.shown.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 text-sm">
              <div className="flex flex-col min-w-0"><span className="font-medium truncate">{p.campaign}</span><span className="text-xs text-f truncate">{p.status === 'paid' ? `Paid ${day(p.paidAt ?? p.at)}` : 'Waiting'}{p.note ? ` · ${p.note}` : ''}</span></div>
              <span className={`num font-semibold ${p.status === 'paid' ? 'text-up' : 'text-m'}`}>{money(p.amount)}</span>
            </div>))}{pays.sentinel}</>
            : <span className="text-sm text-f">No payments yet. They show up here when a campaign pays.</span>}
        </section>
      </div>
    </Page>
  );
}

const monthName = (m: string, short = false) => new Date(`${m}-15`).toLocaleDateString('en-US', { month: short ? 'short' : 'long' });
const pct = (now: number, before: number | undefined) => (before ? Math.round(((now - before) / before) * 100) : null);

/** Months as CSV, built in the browser from the same rows the table shows. */
function exportCsv(months: Month[]) {
  const rows = [['month', 'campaigns', 'clips', 'views', 'earned_usd', 'paid_usd'], ...months.map((m) => [m.month, m.campaigns, m.clips, m.views, m.earned.toFixed(2), m.paid.toFixed(2)])];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.map((r) => r.join(',')).join('\n')],{ type: 'text/csv' }));
  a.download = 'snip-history.csv'; a.click(); URL.revokeObjectURL(a.href);
}

export function History() {
  const { data, isLoading, error } = useHistory();
  if (error) return <Down title="History" />;
  if (isLoading || !data) return <Loading title="History" />;
  const months = data.months, cur = new Date().toISOString().slice(0, 7), bars = months.slice(0, 6).reverse();
  const top = Math.max(...bars.map((m) => m.earned), 0.01), total = months.reduce((t, m) => t + m.earned, 0);
  const first = months.at(-1)?.month;
  return (
    <Page kicker={first ? `Since ${monthName(first)} ${first.slice(0, 4)} · all platforms` : 'All platforms'} title="History"
      right={<div className="flex gap-3">{months.length ? <button className="btn" onClick={() => exportCsv(months)}><Icon name="download" size={16} />Export</button> : null}<Currency /></div>}>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_420px] gap-6 shrink-0">
        <section className="card flex flex-col gap-4 min-h-[280px]">
          <div className="flex items-center justify-between"><h2 className="text-[17px] font-semibold m-0">Earned per month</h2><span className="kicker">Total {money(total, true)}</span></div>
          {bars.length ? <div className="flex-1 flex items-end justify-around gap-4 pt-6">
            {bars.map((m) => (
              <div key={m.month} className="flex flex-col items-center gap-2 h-full justify-end w-16">
                <span className="text-sm font-semibold num">{money(m.earned)}</span>
                <motion.div initial={{ height: 0 }} animate={{ height: `${Math.max(4, (m.earned / top) * 100)}%` }} transition={{ duration: 0.5, ease: 'easeOut' }}
                  className={`w-full rounded-lg max-h-[150px] ${m.month === cur ? 'bg-up/40' : 'bg-up'}`} style={{ minHeight: 6 }} />
                <span className="kicker whitespace-nowrap">{monthName(m.month, true)}{m.month === cur ? ' · so far' : ''}</span>
              </div>))}
          </div> : <Empty icon="money" title="Nothing earned yet" text="Each month shows up here once clips get views." />}
        </section>
        <section className="card !p-0 flex flex-col min-h-[280px] md:max-h-[320px]">
          <div className="flex items-center justify-between h-14 px-5 shrink-0"><h2 className="text-[17px] font-semibold m-0">Ended campaigns</h2><span className="kicker num">{data.ended.length}</span></div>
          <div className="scroll flex-1 min-h-0 px-5">
            {data.ended.length ? data.ended.map((c) => (
              <a key={c.name} href={`#/campaigns/${c.name}`} className="flex items-center gap-3 h-14 no-underline border-b border-line last:border-0">
                <span className="w-8 h-8 rounded-full bg-r flex items-center justify-center text-xs font-semibold uppercase shrink-0">{c.name[0]}</span>
                <span className="flex-1 min-w-0 flex flex-col"><span className="font-semibold truncate text-sm">{c.name}</span>
                  <span className="text-xs text-f">Ended {new Date(c.endsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {c.paid > 0 ? 'Paid' : c.posts ? `${c.posts} clip${c.posts === 1 ? '' : 's'}, not paid yet` : 'No clips posted'}</span></span>
                <span className={`num font-semibold ${c.paid > 0 ? 'text-up' : 'text-m'}`}>{money(c.paid > 0 ? c.paid : c.earned, true)}</span>
              </a>)) : <Empty icon="flag" title="No ended campaigns" text="Campaigns move here when they end." />}
          </div>
        </section>
      </div>
      <section className={`card !p-0 flex flex-col overflow-hidden ${months.length ? 'md:flex-1 md:min-h-0' : ''}`}>
        {months.length ? <>
          <div className="scroll flex-1 min-h-0">
            <table className="tbl">
              <thead><tr><th>Month</th><th className="r">Campaigns</th><th className="r">Clips</th><th className="r hidden md:table-cell">Views</th><th className="r">Earned</th><th className="r hidden md:table-cell">Paid out</th><th className="r hidden md:table-cell">vs last month</th></tr></thead>
              <tbody>{months.map((m, i) => { const d = pct(m.earned, months[i + 1]?.earned); return (
                <tr key={m.month}>
                  <td><span className="font-semibold">{monthName(m.month)}</span>{m.month === cur ? <span className="pill ml-3 !h-7"><span className="dot" style={{ background: 'var(--color-a)' }} />In progress</span> : null}</td>
                  <td className="r num">{count(m.campaigns)}</td>
                  <td className="r num">{count(m.clips)}</td>
                  <td className="r num hidden md:table-cell">{count(m.views)}</td>
                  <td className={`r num font-semibold ${m.earned > 0 ? 'text-up' : 'text-m'}`}>{money(m.earned, true)}</td>
                  <td className="r num hidden md:table-cell">{m.paid > 0 ? money(m.paid, true) : <span className="text-f">—</span>}</td>
                  <td className={`r num hidden md:table-cell font-semibold ${d == null ? 'text-f' : d >= 0 ? 'text-up' : 'text-down'}`}>{d == null ? '—' : `${d >= 0 ? '+' : ''}${d}%`}</td>
                </tr>); })}
              </tbody>
            </table>
          </div><div className="more"><span>Showing <b className="text-t">{months.length}</b> of <b className="text-t">{months.length}</b></span><span>All shown</span></div></>
          : <Empty icon="clock" title="Nothing posted yet" text="Every month with posted clips shows up here." />}
      </section>
    </Page>
  );
}

const PLATFORMS: [string, string][] = [['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['instagram', 'Instagram']];
const PROFILE: Record<string, string> = { youtube: 'https://www.youtube.com/@', tiktok: 'https://www.tiktok.com/@', instagram: 'https://www.instagram.com/' };
// Fan/clip page names: platforms ban accounts that pose as the streamer, so every idea says "clips".
// Less common combos first: short ones like "<name>clips" are usually taken already.
const ideasFor = (n: string) => [n + '.clips.hq', n + 'clipzone', n + '.moments.tv', 'daily' + n + 'clips', n + 'clips.vault', n + '_highlights_hq'];

/** Social accounts per campaign: add, connect, remove, and the one-time platform app keys. Replaces the old /setup page. */
export function Accounts() {
  const { data, isLoading, error } = useAccounts(), toast = useToast();
  const [adding, setAdding] = useState(false);
  // OAuth callbacks land on /app/?msg=…#/accounts: show it once, then clean the address.
  useEffect(() => {
    const msg = new URLSearchParams(location.search).get('msg');
    if (!msg) return;
    toast({ text: msg, tone: /connected/i.test(msg) ? 'up' : 'info' });
    history.replaceState(null, '', location.pathname + location.hash);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <Down title="Accounts" />;
  if (isLoading || !data) return <Loading title="Accounts" />;
  const open = adding || !data.accounts.length;
  return (
    <Page kicker={`${data.accounts.filter((a) => a.connected || a.via === 'postpeer').length} of ${data.accounts.length} ready · max ${data.limit} posts a day each`} title="Accounts"
      right={<button className="btn btn-1" onClick={() => setAdding(!open)} aria-expanded={open} aria-controls="add-account"><Icon name={open ? 'x' : 'plus'} size={16} />{open ? 'Close' : 'Add account'}</button>}>
      <div className="scroll flex-1 min-h-0 -mr-2 pr-2"><div className="flex flex-col gap-8 pb-6">
        <AnimatePresence initial={false}>{open ? <AddAccount key="add" data={data} onDone={() => setAdding(false)} /> : null}</AnimatePresence>
        {data.accounts.length ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 min-[2200px]:grid-cols-4 gap-4 content-start">
            <AnimatePresence initial={false}>{data.accounts.map((a) => <AccountCard key={a.id} a={a} data={data} />)}</AnimatePresence>
          </div>
        ) : null}
        {data.titleTest ? <p className="card !py-3 text-sm m-0 flex items-center gap-2"><Icon name="check" size={16} className="text-up" />{data.titleTest}</p> : null}
        <section className="flex flex-col gap-4" aria-labelledby="apps-h">
          <div className="flex flex-col gap-1"><h2 id="apps-h" className="text-lg font-semibold m-0">Platform apps</h2>
            <p className="text-sm text-m m-0">One time per platform. Keys go straight into .env on the PC and are never shown again.{data.hasPostpeer ? ' TikTok and Instagram post through PostPeer, so only YouTube needs its own app.' : ''}</p></div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 content-start">{data.apps.map((p) => <AppCard key={p.platform} app={p} />)}</div>
        </section>
      </div></div>
    </Page>
  );
}

function AccountCard({ a, data }: { a: Account; data: AccountsData }) {
  const qc = useQueryClient(), toast = useToast(), [sure, setSure] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => { if (!sure) return; const t = setTimeout(() => setSure(false), 4000); return () => clearTimeout(t); }, [sure]);
  const app = data.apps.find((p) => p.platform === a.platform);
  const remove = async () => {
    if (!sure) return setSure(true);
    setBusy(true);
    try { await post(`/setup/account/${a.id}/delete`); toast({ text: `Removed ${a.name}`, tone: 'down' }); await qc.invalidateQueries({ queryKey: ['accounts'] }); }
    catch (e) { toast({ text: e instanceof Error && e.message.length > 3 ? e.message : 'That did not work. Try again.', tone: 'info' }); setBusy(false); setSure(false); }
  };
  const [tone, label] = a.via === 'postpeer' ? ['var(--color-up)', 'Via PostPeer'] : a.via === 'needs_postpeer' ? ['var(--color-warn)', 'Needs PostPeer']
    : a.connected ? ['var(--color-up)', 'Connected'] : ['var(--color-warn)', 'Not connected'];
  return (
    <motion.section layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.2 }} className="card flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col min-w-0"><span className="font-semibold truncate">{a.name}</span><span className="text-sm text-m">{a.label} · {a.streamer ?? 'no campaign'} · {a.today} of {data.limit} today</span></div>
        <span className="pill shrink-0"><span className="dot" style={{ background: tone }} />{label}</span>
      </div>
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="flex flex-col"><span className="text-m">Posts</span><span className="num font-semibold text-lg">{count(a.posts)}</span></div>
        <div className="flex flex-col"><span className="text-m">Views</span><span className="num font-semibold text-lg">{count(a.views)}</span></div>
        <div className="flex flex-col"><span className="text-m">{a.pool ? 'Pays' : 'Earned'}</span><span className={`num font-semibold text-lg ${a.earned > 0 ? 'text-up' : ''}`}>{a.pool ? 'At the end' : money(a.earned)}</span></div>
      </div>
      {a.via === 'postpeer' ? <p className="text-[13px] text-m m-0">Connect or change it on <a href="https://postpeer.dev" target="_blank" rel="noopener">postpeer.dev</a>.</p>
        : a.via === 'needs_postpeer' ? <p className="text-[13px] text-warn m-0">{a.label} posts go through PostPeer. Add its key to .env first.</p>
        : !app?.ready ? <p className="text-[13px] text-warn m-0">Set up the {app?.label ?? a.label} app below first.</p>
        : a.platform === 'youtube' && !a.connected && !/^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? <PasteBack /> : null}
      <div className="flex gap-2 mt-auto">
        {a.via === 'oauth' ? (app?.ready
          ? <a href={a.connectUrl} className={`btn flex-1 no-underline ${a.connected ? '' : 'btn-1'}`}><Icon name="link" size={16} />{a.connected ? 'Connect again' : 'Connect account'}</a>
          : <button className="btn flex-1" disabled><Icon name="link" size={16} />Connect account</button>) : <span className="flex-1" />}
        <button className={`btn ${sure ? '!text-down !border-[var(--color-down)]' : ''}`} onClick={remove} disabled={busy} aria-busy={busy} aria-label={sure ? `Yes, remove ${a.name}` : `Remove ${a.name}`}>
          {busy ? <span className="spin" aria-hidden /> : <Icon name="trash" size={16} />}{sure ? 'Sure? Remove' : 'Remove'}</button>
      </div>
    </motion.section>
  );
}

/** Phone login: Google returns to the PC's own address, so the phone shows an error page. Its address finishes the login here. */
function PasteBack() {
  const qc = useQueryClient(), toast = useToast(), [v, setV] = useState(''), [busy, setBusy] = useState(false);
  const send = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await post('/setup/paste', { url: v }); setV(''); toast({ text: 'Account connected', tone: 'up' }); await qc.invalidateQueries({ queryKey: ['accounts'] }); }
    catch (er) { toast({ text: er instanceof Error && er.message.length > 3 ? er.message : 'That did not work. Try again.', tone: 'info' }); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={send} className="flex flex-col gap-2">
      <label htmlFor="paste-back" className="text-[13px] text-m">On your phone: after Allow, the page will not load. Copy its whole address and paste it here.</label>
      <div className="flex gap-2"><input id="paste-back" value={v} onChange={(e) => setV(e.target.value)} placeholder="http://127.0.0.1:8787/oauth/youtube?…" autoComplete="off"
        className="h-11 px-3 rounded-[12px] bg-s border border-line text-t text-sm focus:outline-none focus:border-a flex-1 min-w-0" />
        <button className="btn !h-11" disabled={busy || !v.trim()} aria-busy={busy}>{busy ? <span className="spin" aria-hidden /> : null}Finish</button></div>
    </form>
  );
}

function AddAccount({ data, onDone }: { data: AccountsData; onDone: () => void }) {
  const qc = useQueryClient(), toast = useToast();
  const [platform, setPlatform] = useState('tiktok'), [camp, setCamp] = useState(data.campaigns[0]?.id ?? 0);
  const [name, setName] = useState<string | null>(null), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const [free, setFree] = useState<Record<string, boolean | null>>({});
  const streamer = data.campaigns.find((c) => c.id === camp)?.name ?? '';
  const n = (streamer || 'stream').toLowerCase().replace(/[^a-z0-9]/g, ''), ideas = ideasFor(n);
  const plat = PLATFORMS.find(([k]) => k === platform)![1];
  const shown = name ?? `${streamer ? streamer[0].toUpperCase() + streamer.slice(1) + ' clips' : 'Clips'} ${plat}`;
  // Only YouTube can say if a handle is free (Data API key); other platforms: open the profile and look (no scraping).
  useEffect(() => {
    if (platform !== 'youtube' || !data.canCheckNames) return;
    let live = true;
    for (const t of ideas) fetch(`/setup/handle/${encodeURIComponent(t)}`).then((r) => r.json()).then((j: { free: boolean | null }) => live && setFree((f) => ({ ...f, [t]: j.free })), () => {});
    return () => { live = false; };
  }, [platform, n]); // eslint-disable-line react-hooks/exhaustive-deps
  const copy = (t: string) => (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast({ text: `Copied ${t}`, tone: 'up' }), () => toast({ text: t, tone: 'info' }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!shown.trim()) return setErr('Give it a name.');
    setBusy(true); setErr('');
    try { await post('/setup/account', { platform, streamerId: camp || null, name: shown.trim() }); toast({ text: `Added ${shown.trim()}`, tone: 'up' }); await qc.invalidateQueries({ queryKey: ['accounts'] }); onDone(); }
    catch (e) { setErr(e instanceof Error && e.message.length > 3 ? e.message : 'That did not work. Try again.'); }
    setBusy(false);
  };
  return (
    <motion.form id="add-account" onSubmit={submit} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}
      className="card flex flex-col gap-5" aria-labelledby="add-h">
      <div className="flex flex-col gap-1"><h2 id="add-h" className="text-lg font-semibold m-0">Add an account</h2>
        <p className="text-sm text-m m-0">Make the account on the platform first, then add it here and press Connect.</p></div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <fieldset className="flex flex-col gap-2 m-0 p-0 border-0"><legend className="text-sm text-m mb-2">Platform</legend>
          <div className="segs self-start" role="group">{PLATFORMS.map(([k, l]) => <button type="button" key={k} className="seg" aria-pressed={platform === k} onClick={() => setPlatform(k)}>{l}</button>)}</div></fieldset>
        <label className="flex flex-col gap-2 text-sm text-m">Campaign
          <select className="field" value={camp} onChange={(e) => setCamp(Number(e.target.value))}>
            {data.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}<option value={0}>No campaign</option></select></label>
        <label className="flex flex-col gap-2 text-sm text-m">Name in Snip
          <input className="field" value={shown} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" /></label>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm text-m">Name ideas for the {plat} handle. Tap to copy, then check if it is free.</span>
        <ul className="flex flex-wrap gap-2 m-0 p-0 list-none">{ideas.map((t) => {
          const f = platform === 'youtube' ? free[t] : undefined;
          return <li key={t} className={`pill !p-0 overflow-hidden ${f === false ? 'opacity-50' : ''}`}>
            <button type="button" className="px-3 min-h-[44px] bg-transparent border-0 text-t cursor-pointer hover:bg-[var(--color-r)] transition-colors" onClick={() => copy(t)} disabled={f === false} aria-label={`Copy @${t}`}>@{t}</button>
            {f === false ? <span className="px-3 text-m">Taken</span> : f === true ? <span className="px-3 text-up font-semibold">Free</span>
              : <a href={PROFILE[platform] + t} target="_blank" rel="noopener" className="px-3 min-h-[44px] flex items-center border-l border-[var(--color-line)] no-underline" aria-label={`Check if @${t} is free`}>Check</a>}
          </li>;
        })}</ul>
      </div>
      {err ? <p className="text-sm text-warn m-0" role="alert">{err}</p> : null}
      <div className="flex gap-2"><button className="btn btn-1" disabled={busy} aria-busy={busy}>{busy ? <span className="spin" aria-hidden /> : <Icon name="plus" size={16} />}Add account</button>
        {data.accounts.length ? <button type="button" className="btn" onClick={onDone}>Cancel</button> : null}</div>
    </motion.form>
  );
}

function AppCard({ app }: { app: AppSetup }) {
  const qc = useQueryClient(), toast = useToast(), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget, body: Record<string, string> = {};
    for (const i of form.querySelectorAll('input')) if (i.value.trim()) body[i.name] = i.value.trim();
    if (!Object.keys(body).length) return setErr('Paste at least one value.');
    setBusy(true); setErr('');
    try { await post(`/setup/app/${app.platform}`, body); form.reset(); toast({ text: `${app.label} keys saved`, tone: 'up' }); await qc.invalidateQueries({ queryKey: ['accounts'] }); }
    catch (e) { setErr(e instanceof Error && e.message.length > 3 ? e.message : 'That did not work. Try again.'); }
    setBusy(false);
  };
  return (
    <form onSubmit={submit} className="card flex flex-col gap-4" aria-label={`${app.label} app`}>
      <div className="flex items-center justify-between gap-3"><span className="font-semibold flex items-center gap-2"><Icon name="key" size={16} />{app.label}</span>
        <span className="pill"><span className="dot" style={{ background: app.ready ? 'var(--color-up)' : 'var(--color-warn)' }} />{app.ready ? 'Ready' : 'Not set up'}</span></div>
      <details open={!app.ready} className="text-sm"><summary className="cursor-pointer text-m min-h-[44px] flex items-center">How to set up (one time)</summary>
        {/* steps are fixed server text with links (setup.ts APPS), not user input */}
        <ol className="flex flex-col gap-2 m-0 pl-5 leading-relaxed list-decimal marker:text-f">{app.steps.map((s, i) => <li key={i} dangerouslySetInnerHTML={{ __html: s }} />)}</ol></details>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{app.fields.map((f) => (
        <label key={f.key} className="flex flex-col gap-2 text-sm text-m">{f.label}
          <input className="field" name={f.key} type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={f.saved ? 'Saved. Paste to replace' : 'Paste here'} /></label>))}</div>
      {err ? <p className="text-sm text-warn m-0" role="alert">{err}</p> : null}
      <button className="btn self-start" disabled={busy} aria-busy={busy}>{busy ? <span className="spin" aria-hidden /> : <Icon name="check" size={16} />}Save keys</button>
    </form>
  );
}
