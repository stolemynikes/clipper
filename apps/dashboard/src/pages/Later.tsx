import { Empty, Page } from '../ui.tsx';

const TEXT: Record<string, [string, string, string]> = {
  earnings: ['money', 'No earnings data yet', 'This fills in once clips are posted and the first campaign pays out.'],
  history: ['clock', 'No history yet', 'Ended campaigns and monthly totals show up here after the first payout.'],
  accounts: ['user', 'No account stats yet', 'Views per TikTok, YouTube and Instagram account show up once clips are posted.'],
};

export function Later({ what }: { what: string }) {
  if (what === 'settings') {
    return (
      <Page title="Settings">
        <div className="card flex flex-col gap-4 max-w-xl">
          <span className="text-m text-sm">Settings still live on the older pages for now.</span>
          <div className="flex flex-wrap gap-3">
            <a className="btn" href="/setup">Accounts and keys</a>
            <a className="btn" href="/campaigns">Edit campaigns</a>
          </div>
        </div>
      </Page>
    );
  }
  const [icon, title, text] = TEXT[what] ?? ['alert', 'Page not found', 'This page does not exist.'];
  return <Page title={what in TEXT ? what[0].toUpperCase() + what.slice(1) : 'Not found'}><div className="card flex flex-1"><Empty icon={icon} title={title} text={text} /></div></Page>;
}
