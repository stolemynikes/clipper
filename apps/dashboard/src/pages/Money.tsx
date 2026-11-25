import { motion } from 'motion/react';
import { count, money, useAccounts, useEarnings, useHistory, type Month } from '../api.ts';
import { Counter, Currency, Empty, Icon, Page, Skeleton, Stat, useMore } from '../ui.tsx';

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

export function Accounts() {
  const { data, isLoading, error } = useAccounts();
  if (error) return <Down title="Accounts" />;
  if (isLoading || !data) return <Loading title="Accounts" />;
  return (
    <Page kicker={`${data.accounts.filter((a) => a.connected).length} of ${data.accounts.length} connected · max ${data.limit} posts a day each`} title="Accounts" right={<a className="btn" href="/setup"><Icon name="link" size={16} />Manage accounts</a>}>
      {data.accounts.length ? (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4 md:scroll md:min-h-0 content-start">
          {data.accounts.map((a) => (
            <section key={a.id} className="card flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col min-w-0"><span className="font-semibold truncate">{a.name}</span><span className="text-sm text-m">{a.label} · {a.streamer ?? "no campaign"} · {a.today} of {data.limit} today</span></div>
                <span className="pill"><span className="dot" style={{ background: a.connected ? 'var(--color-up)' : 'var(--color-warn)' }} />{a.connected ? 'Connected' : 'Not connected'}</span>
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="flex flex-col"><span className="text-m">Posts</span><span className="num font-semibold text-lg">{count(a.posts)}</span></div>
                <div className="flex flex-col"><span className="text-m">Views</span><span className="num font-semibold text-lg">{count(a.views)}</span></div>
                <div className="flex flex-col"><span className="text-m">{a.pool ? 'Pays' : 'Earned'}</span><span className={`num font-semibold text-lg ${a.earned > 0 ? 'text-up' : ''}`}>{a.pool ? 'At the end' : money(a.earned)}</span></div>
              </div>
            </section>))}
        </div>
      ) : <div className="card flex flex-1"><Empty icon="user" title="No accounts yet" text="Add a TikTok, YouTube or Instagram account to start posting." /></div>}
    </Page>
  );
}
