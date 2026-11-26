import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ago, post, useReady, type ReadyAccount, type ReadyClip } from '../api.ts';
import { Empty, Icon, Page, Skeleton, useToast } from '../ui.tsx';

const input = 'h-12 px-4 rounded-[14px] bg-s border border-line text-t text-base focus:outline-none focus:border-a w-full min-w-0';

/** Copies text; the toast says what was copied so it works one-handed on the phone. */
function CopyBtn({ text, what }: { text: string; what: string }) {
  const toast = useToast();
  return <button className="btn !h-11" onClick={() => navigator.clipboard.writeText(text).then(() => toast({ text: `${what} copied`, tone: 'up' }), () => toast({ text: 'Copy did not work. Hold the text to copy it.', tone: 'info' }))}>
    <Icon name="check" size={16} />Copy {what.toLowerCase()}</button>;
}

function AccountRow({ clip, a }: { clip: ReadyClip; a: ReadyAccount }) {
  const qc = useQueryClient(), toast = useToast(), [busy, setBusy] = useState(''), [link, setLink] = useState('');
  const act = async (what: 'post' | 'link') => {
    setBusy(what);
    try {
      await post(`/ready/${clip.id}/${what}/${a.id}`, what === 'link' ? { url: link } : undefined);
      toast({ text: what === 'post' ? `Posted to ${a.label}` : 'Link saved. Views are tracked from now on.', tone: 'up' });
      setLink(''); await qc.invalidateQueries({ queryKey: ['ready'] });
    } catch (e) { toast({ text: (e as Error).message, tone: 'info' }); }
    finally { setBusy(''); }
  };
  const caption = a.platform === 'youtube' ? `${a.text.title}\n\n${a.text.description}` : a.text.title;
  return (
    <div className="flex flex-col gap-3 py-4 border-b border-line last:border-0 last:pb-0">
      <div className="flex items-center gap-3 min-w-0">
        <span className="w-10 h-10 shrink-0 rounded-[12px] bg-r flex items-center justify-center font-semibold uppercase">{a.platform[0]}</span>
        <span className="flex-1 min-w-0 flex flex-col"><span className="font-semibold">{a.label}</span><span className="text-sm text-m truncate">{a.name}</span></span>
        {a.posted ? (a.url ? <a href={a.url} target="_blank" rel="noreferrer" className="btn !h-11"><Icon name="link" size={16} />Open post</a> : <span className="text-sm text-m">Posted, link comes soon</span>)
          : a.canPost ? <button className="btn btn-1 !h-11" disabled={!!busy || !clip.file} onClick={() => act('post')}><Icon name="upload" size={16} />{busy === 'post' ? 'Posting…' : 'Post'}</button> : null}
      </div>
      {a.posted ? null : <>
        <pre className="m-0 p-3 rounded-[12px] bg-s border border-line text-sm whitespace-pre-wrap break-words font-[inherit]">{caption}</pre>
        <div className="flex flex-wrap gap-2"><CopyBtn text={caption} what={a.platform === 'youtube' ? 'Title and text' : 'Caption'} /></div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (link.trim()) act('link'); }}>
          <label htmlFor={`link-${clip.id}-${a.id}`} className="sr-only">Link of your {a.label} post</label>
          <input id={`link-${clip.id}-${a.id}`} className={input} inputMode="url" placeholder={`Posted by hand? Paste the ${a.label} link`} value={link} onChange={(e) => setLink(e.target.value)} />
          <button className="btn !h-12 shrink-0" disabled={!!busy || !link.trim()}>{busy === 'link' ? 'Saving…' : 'Save'}</button>
        </form>
      </>}
    </div>
  );
}

function ClipCard({ c }: { c: ReadyClip }) {
  return (
    <section className="card flex flex-col md:flex-row gap-5">
      <div className="flex flex-col gap-3 md:w-[240px] shrink-0">
        {c.file ? <video src={`/clip/${c.id}.mp4`} controls playsInline preload="metadata" className="w-full aspect-[9/16] rounded-[14px] bg-black object-contain" />
          : <div className="w-full aspect-[9/16] rounded-[14px] bg-s border border-line flex items-center justify-center text-sm text-m p-4 text-center">The video file was cleaned up</div>}
        {c.file ? <a href={`/clip/${c.id}.mp4`} download={`${c.streamer}-clip-${c.id}.mp4`} className="btn !h-11 justify-center"><Icon name="download" size={16} />Download</a> : null}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <span className="kicker">{c.streamer} · {c.seconds}s · kept {ago(c.at)}</span>
        <h2 className="text-[17px] font-semibold m-0">{c.title ?? `Clip ${c.id}`}</h2>
        <div className="flex flex-col">
          {c.accounts.length ? c.accounts.map((a) => <AccountRow key={a.id} clip={c} a={a} />)
            : <span className="text-sm text-m pt-3">No account for {c.streamer} yet. <a href="#/accounts">Add one in Accounts</a>, then post from here.</span>}
        </div>
      </div>
    </section>
  );
}

/** Kept clips that still need to go up. Post through Snip, or download, copy the text and paste the link back. */
export function Ready() {
  const { data } = useReady();
  const open = (data ?? []).filter((c) => c.accounts.some((a) => !a.posted) || !c.accounts.length);
  return (
    <Page kicker="Kept clips" title="Ready to post">
      <div className="scroll flex-1 min-h-0 flex flex-col gap-6">
        {!data ? [1, 2].map((i) => <Skeleton key={i} className="h-96" />)
          : !open.length ? <div className="card"><Empty icon="upload" title="Nothing waiting" text="Clips you keep in Review show up here until they are on every account." /></div>
          : open.map((c) => <ClipCard key={c.id} c={c} />)}
      </div>
    </Page>
  );
}
