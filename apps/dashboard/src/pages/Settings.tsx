import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { fee, post, pref, setPref, useOverview, useSettings, type SettingField } from '../api.ts';
import { Currency, Icon, Page, Skeleton, useToast } from '../ui.tsx';

type Row = { key: string; title: string; text: string; on: boolean; path: (on: boolean) => string; done: (on: boolean) => string };

const Card = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="card flex flex-col gap-5"><h2 className="text-[17px] font-semibold m-0">{title}</h2>{children}</section>
);
const Field = ({ id, label, help, children }: { id?: string; label: string; help?: string; children: ReactNode }) => (
  <div className="flex flex-col gap-2">{id ? <label htmlFor={id} className="kicker">{label}</label> : <span className="kicker">{label}</span>}{children}{help ? <span className="text-sm text-m">{help}</span> : null}</div>
);
const input = 'h-12 px-4 rounded-[14px] bg-s border border-line text-t text-base focus:outline-none focus:border-a w-full';
const Switch = ({ on, label, busy, onClick }: { on: boolean; label: string; busy: boolean; onClick: () => void }) => (
  <button role="switch" aria-checked={on} aria-labelledby={label} disabled={busy} onClick={onClick}
    className={`relative shrink-0 w-[52px] h-8 rounded-full border border-line transition-colors cursor-pointer disabled:opacity-50 ${on ? 'bg-p' : 'bg-r'}`}>
    <span className={`absolute top-[3px] left-[3px] w-6 h-6 rounded-full bg-white transition-transform motion-reduce:transition-none ${on ? 'translate-x-5' : ''}`} />
  </button>
);

/** One settings.yaml value. Numbers save when you leave the box; a refused value shows the reason and goes back. */
function Setting({ f }: { f: SettingField }) {
  const qc = useQueryClient(), toast = useToast(), [busy, setBusy] = useState(false), [text, setText] = useState(String(f.value ?? ''));
  const id = `set-${f.key.replace(/\./g, '-')}`;
  const save = async (v: string) => {
    if (v === String(f.value)) return;
    setBusy(true);
    try { await post(`/settings?key=${encodeURIComponent(f.key)}&value=${encodeURIComponent(v)}`); toast({ text: `${f.label}: saved`, tone: 'up' }); }
    catch (e) { setText(String(f.value ?? '')); toast({ text: `${f.label}: ${(e as Error).message}`, tone: 'info' }); }
    finally { await qc.invalidateQueries({ queryKey: ['settings'] }); await qc.invalidateQueries({ queryKey: ['accounts'] }); setBusy(false); }
  };
  const head = <div className="flex flex-col gap-1 min-w-0"><label id={id} htmlFor={f.type === 'number' ? `${id}-in` : undefined} className="font-semibold">{f.label}</label><span className="text-sm text-m">{f.help}</span></div>;
  const row = 'flex items-center justify-between gap-4 py-4 border-b border-line last:border-0 last:pb-0';
  if (f.type === 'bool') return <div className={row}>{head}<Switch on={f.value === true} label={id} busy={busy} onClick={() => save(String(f.value !== true))} /></div>;
  if (f.type === 'choice') return (
    <div className="flex flex-col gap-3 py-4 border-b border-line last:border-0 last:pb-0">{head}
      <div className="segs self-start" role="group" aria-labelledby={id}>{f.options!.map((o) => <button key={o} className="seg capitalize" disabled={busy} aria-pressed={f.value === o} onClick={() => save(o)}>{o}</button>)}</div>
    </div>
  );
  return (
    <div className={row}>{head}
      <div className="relative shrink-0 w-[104px]">
        <input id={`${id}-in`} type="number" inputMode="decimal" min={f.min} max={f.max} step={f.step} disabled={busy} value={text}
          className={`${input} num text-right ${f.unit ? 'pr-12' : ''}`} onChange={(e) => setText(e.target.value)}
          onBlur={() => save(text.trim())} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        {f.unit ? <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-m pointer-events-none">{f.unit}</span> : null}
      </div>
    </div>
  );
}
const Group = ({ name, fields }: { name: string; fields: SettingField[] }) => (
  <Card title={name}><div className="flex flex-col -mt-4">{fields.filter((f) => f.group === name).map((f) => <Setting key={`${f.key}:${String(f.value)}`} f={f} />)}</div></Card>
);

/** Owner settings. Name, currency and fee live in this browser; the switches are files in data/ on the PC. */
export function Settings() {
  const { data } = useOverview(), fields = useSettings().data ?? [];
  const qc = useQueryClient(), toast = useToast(), [busy, setBusy] = useState('');
  const [name, setName] = useState(pref('appName', 'Snip')), [f, setF] = useState(String(fee()));
  if (!data) return <Page title="Settings"><div className="grid grid-cols-3 gap-6">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-80" />)}</div></Page>;
  const run: Row = { key: 'run', title: 'Keep running', text: 'Turn off to stop all work, for example while you play a game. Nothing is lost.', on: !data.paused,
    path: (on) => (on ? '/resume' : '/pause'), done: (on) => (on ? 'Snip is running again' : 'Snip is paused') };
  const work: Row[] = [
    { key: 'study', title: 'Study top clips', text: "Watches the best clips of a new campaign's streamer first. Uses a lot of the PC.", on: data.study,
      path: (on) => `/toggle/study/${on ? 'on' : 'off'}`, done: (on) => (on ? 'Studying is on' : 'Studying is off. Waiting studies stay in line.') },
    { key: 'learn', title: 'Weekly learning', text: 'Once a week, looks at which clips got views and adjusts how it picks moments.', on: data.learning,
      path: (on) => `/toggle/learn/${on ? 'on' : 'off'}`, done: (on) => (on ? 'Weekly learning is on' : 'Weekly learning is off') },
    { key: 'practice', title: 'Practice at night', text: 'Makes practice clips from older VODs. Never posted, deleted after scoring.', on: data.practice,
      path: (on) => `/toggle/practice/${on ? 'on' : 'off'}`, done: (on) => (on ? 'Practice is on' : 'Practice stops after the current step') },
    { key: 'claude', title: 'Claude watches along', text: 'Checks the practice run now and then and fixes errors. Off saves your Claude usage.', on: data.claude,
      path: (on) => `/toggle/claude/${on ? 'on' : 'off'}`, done: (on) => (on ? 'Claude watches along' : 'Claude stops watching. Practice keeps running.') },
  ];
  const flip = async (r: Row) => {
    setBusy(r.key);
    try { await post(r.path(!r.on)); toast({ text: r.done(!r.on), tone: r.on ? 'down' : 'up' }); await qc.invalidateQueries({ queryKey: ['overview'] }); }
    catch { toast({ text: 'That did not work. Try again.', tone: 'info' }); }
    finally { setBusy(''); }
  };
  const sw = (r: Row) => (
    <div key={r.key} className="flex items-center justify-between gap-4 py-4 border-b border-line last:border-0 last:pb-0">
      <div className="flex flex-col gap-1 min-w-0"><span id={`s-${r.key}`} className="font-semibold">{r.title}</span><span className="text-sm text-m">{r.text}</span></div>
      <Switch on={r.on} label={`s-${r.key}`} busy={busy === r.key} onClick={() => flip(r)} />
    </div>
  );
  const perSite = (s: string) => data.campaigns.filter((c) => c.site === s).length;
  return (
    <Page kicker="Changes save automatically" title="Settings" right={<Currency />}>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
        <div className="flex flex-col gap-6">
          <Card title="App">
            <Field id="app-name" label="App name" help="Shown in the sidebar of this browser.">
              <input id="app-name" className={input} value={name} maxLength={24} onChange={(e) => setName(e.target.value)}
                onBlur={() => { setPref('appName', name.trim() || 'Snip'); toast({ text: 'Name saved', tone: 'up' }); }} />
            </Field>
          </Card>
          <Card title="Campaign platforms">
            <div className="flex flex-col">
              {data.sites.length ? data.sites.map((s) => (
                <a key={s} href="#/campaigns" className="flex items-center gap-3 h-16 no-underline border-b border-line last:border-0">
                  <span className="w-10 h-10 rounded-[12px] bg-r flex items-center justify-center font-semibold uppercase">{s[0]}</span>
                  <span className="flex-1 flex flex-col"><span className="font-semibold capitalize">{s.replace(/_/g, ' ')}</span><span className="text-sm text-up">Connected · {perSite(s)} campaign{perSite(s) === 1 ? '' : 's'}</span></span>
                  <span className="btn !h-10">Manage</span>
                </a>)) : <span className="text-sm text-m">No platform yet. Campaigns you join show up here.</span>}
            </div>
            <span className="text-sm text-m">New campaigns are found automatically every day.</span>
          </Card>
        </div>
        <div className="flex flex-col gap-6">
          <Card title="Money">
            <Field label="Currency" help="EUR uses today's ECB rate."><Currency /></Field>
            <Field id="fee" label="Payout fee" help="What the campaign site keeps when it pays you. Home shows what is left.">
              <div className="relative"><input id="fee" inputMode="decimal" className={`${input} pr-10`} value={f} onChange={(e) => setF(e.target.value.replace(/[^\d.]/g, ''))}
                onBlur={() => { setPref('fee', f || '0'); setF(String(fee())); toast({ text: 'Fee saved', tone: 'up' }); }} />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-m">%</span></div>
            </Field>
          </Card>
          <Card title="Posting">
            <div className="flex flex-col -mt-4">{sw(run)}{fields.filter((x) => x.group === 'Posting').map((x) => <Setting key={`${x.key}:${String(x.value)}`} f={x} />)}</div>
          </Card>
        </div>
        <div className="flex flex-col gap-6">
          <Card title="Snip at work">
            <div className="flex flex-col -mt-4">{work.map(sw)}</div>
            <span className="text-sm text-m flex items-center gap-2"><Icon name="alert" size={14} />Alerts go to your phone through Bark.</span>
          </Card>
          <Group name="Review" fields={fields} />
        </div>
        {['Clips', 'Finding moments', 'Watching streams', 'PC'].map((g) => <Group key={g} name={g} fields={fields} />)}
      </div>
    </Page>
  );
}
