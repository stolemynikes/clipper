import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { post, useOverview } from '../api.ts';
import { Page, Skeleton, useToast } from '../ui.tsx';

type Row = { key: string; title: string; text: string; on: boolean; path: (on: boolean) => string; done: (on: boolean) => string };

/** Owner switches: pause everything, study top clips, weekly learning. Each one is a file in data/ on the PC. */
export function Settings() {
  const { data } = useOverview();
  const qc = useQueryClient(), toast = useToast(), [busy, setBusy] = useState('');
  if (!data) return <Page title="Settings"><div className="flex flex-col gap-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}</div></Page>;
  const rows: Row[] = [
    { key: 'run', title: 'Snip is running', text: 'Turn off to stop all work, for example while you play a game. Nothing is lost; it picks up where it was.', on: !data.paused,
      path: (on) => (on ? '/resume' : '/pause'), done: (on) => (on ? 'Snip is running again' : 'Snip is paused') },
    { key: 'study', title: 'Study top clips', text: 'Before making clips for a new campaign, Snip watches the best clips of that streamer to learn what works. Uses a lot of the PC.', on: data.study,
      path: (on) => `/toggle/study/${on ? 'on' : 'off'}`, done: (on) => (on ? 'Studying is on' : 'Studying is off. Waiting studies stay in line.') },
    { key: 'learn', title: 'Weekly learning', text: 'Once a week Snip looks at which clips got views and adjusts how it picks moments.', on: data.learning,
      path: (on) => `/toggle/learn/${on ? 'on' : 'off'}`, done: (on) => (on ? 'Weekly learning is on' : 'Weekly learning is off') },
  ];
  const flip = async (r: Row) => {
    setBusy(r.key);
    try { await post(r.path(!r.on)); toast({ text: r.done(!r.on), tone: r.on ? 'down' : 'up' }); await qc.invalidateQueries({ queryKey: ['overview'] }); }
    catch { toast({ text: 'That did not work. Try again.', tone: 'info' }); }
    finally { setBusy(''); }
  };
  return (
    <Page kicker="Changes apply right away" title="Settings">
      <section className="card !p-0 flex flex-col divide-y divide-line">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-4 p-5">
            <div className="flex flex-col gap-1 min-w-0"><span id={`s-${r.key}`} className="font-semibold">{r.title}</span><span className="text-sm text-m">{r.text}</span></div>
            <button role="switch" aria-checked={r.on} aria-labelledby={`s-${r.key}`} disabled={busy === r.key} onClick={() => flip(r)}
              className={`relative shrink-0 w-[52px] h-8 rounded-full border border-line transition-colors cursor-pointer disabled:opacity-50 ${r.on ? 'bg-p' : 'bg-r'}`}>
              <span className={`absolute top-[3px] left-[3px] w-6 h-6 rounded-full bg-white transition-transform motion-reduce:transition-none ${r.on ? 'translate-x-5' : ''}`} />
            </button>
          </div>))}
      </section>
    </Page>
  );
}
