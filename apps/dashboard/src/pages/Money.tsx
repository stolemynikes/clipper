import { ago, count, money, useAccounts, useEarnings, useHistory } from '../api.ts';
import { Counter, Empty, Icon, Page, Skeleton, Stat, useMore } from '../ui.tsx';

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

export function History() {
  const { data, isLoading, error } = useHistory();
  const more = useMore(data ?? [], 30);
  if (error) return <Down title="History" />;
  if (isLoading || !data) return <Loading title="History" />;
  return (
    <Page kicker={`${count(data.length)} clip${data.length === 1 ? '' : 's'} posted`} title="History">
      <section className="card !p-0 flex flex-col md:flex-1 md:min-h-0 overflow-hidden">
        {data.length ? <>
          <div className="scroll flex-1 min-h-0">
            <table className="tbl">
              <thead><tr><th>Clip</th><th className="hidden md:table-cell">Campaign</th><th className="hidden md:table-cell">Posted on</th><th className="r">Views</th><th className="r">Earned</th></tr></thead>
              <tbody>{more.shown.map((p) => (
                <tr key={p.id}>
                  <td><div className="flex flex-col gap-1 min-w-0"><span className="font-medium truncate">{p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="no-underline">{p.title ?? 'Untitled'}</a> : p.title ?? 'Untitled'}</span><span className="text-xs text-f">{p.postedAt ? ago(p.postedAt) : 'Not posted yet'}{p.submitted ? ' · sent to the campaign' : ''}</span></div></td>
                  <td className="hidden md:table-cell"><a href={`#/campaigns/${p.streamer}`} className="no-underline text-m">{p.streamer}</a></td>
                  <td className="hidden md:table-cell text-m">{p.platform}</td>
                  <td className="r num">{count(p.views)}</td>
                  <td className={`r num font-semibold ${p.earned > 0 ? 'text-up' : 'text-m'}`}>{money(p.earned)}</td>
                </tr>))}
              </tbody>
            </table>
            {more.sentinel}
          </div>{more.footer}</>
          : <Empty icon="clock" title="Nothing posted yet" text="Every clip that goes out shows up here with its views." />}
      </section>
    </Page>
  );
}

export function Accounts() {
  const { data, isLoading, error } = useAccounts();
  if (error) return <Down title="Accounts" />;
  if (isLoading || !data) return <Loading title="Accounts" />;
  return (
    <Page kicker={`${data.filter((a) => a.connected).length} of ${data.length} connected`} title="Accounts" right={<a className="btn" href="/setup"><Icon name="link" size={16} />Manage accounts</a>}>
      {data.length ? (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4 md:scroll md:min-h-0 content-start">
          {data.map((a) => (
            <section key={a.id} className="card flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col min-w-0"><span className="font-semibold truncate">{a.name}</span><span className="text-sm text-m">{a.label} · {a.streamer ?? 'no campaign'}</span></div>
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
