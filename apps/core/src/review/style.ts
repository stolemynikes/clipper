// Shared look for the review and setup pages (dark, big touch targets, plain words).
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const CSS = `:root{--bg:#0b0b0f;--card:#17171c;--line:#26262e;--text:#f4f4f5;--muted:#a1a1aa;--accent:#facc15;--ok:#22c55e;--no:#ef4444}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,sans-serif;padding:env(safe-area-inset-top) 16px calc(24px + env(safe-area-inset-bottom))}
header{position:sticky;top:0;background:var(--bg);padding:16px 0 12px;z-index:1;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
h1{font-size:22px;margin:0;flex:1}
.paused{color:var(--accent)!important}.stats{width:100%;color:var(--muted);font-size:14px;margin:0}
button{font:inherit;font-weight:600;min-height:48px;border-radius:12px;border:0;cursor:pointer;transition:transform .1s,opacity .2s}
button:active{transform:scale(.97)}button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.toggle{min-height:44px;padding:0 16px;background:var(--card);color:var(--text);border:1px solid var(--line)}
article{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;margin:0 auto 16px;max-width:480px;transition:opacity .25s,transform .25s}
article[aria-busy=true]{opacity:.5;pointer-events:none}article.gone{opacity:0;transform:scale(.96)}
video{display:block;width:100%;aspect-ratio:9/16;max-height:70vh;background:#000}
.head{display:flex;align-items:center;gap:12px;justify-content:space-between;margin-bottom:4px}.head .title{margin:0}
.score{flex:none;display:flex;align-items:baseline;gap:2px;padding:6px 12px;border-radius:12px;font-size:14px;color:var(--muted);background:var(--bg);border:1px solid var(--line)}
.score b{font-size:24px;line-height:1;color:var(--text)}.score span{margin-left:8px;font-weight:600}
.score.hi{border-color:var(--ok)}.score.hi span{color:var(--ok)}.score.mid{border-color:var(--accent)}.score.mid span{color:var(--accent)}.score.lo span{color:var(--muted)}
.meta{padding:12px 16px 0}.meta p{margin:0 0 4px}.sub{color:var(--muted);font-size:14px}a{color:var(--accent)}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px 16px 16px}
.ok{background:var(--ok);color:#052e16}.no{background:transparent;color:var(--no);border:2px solid var(--no)}
.empty{color:var(--muted);text-align:center;padding:48px 0}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;margin:4px 0 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px;text-align:center}
.tile b{display:block;font-size:24px}.tile span{color:var(--muted);font-size:13px}
.note{margin:4px 0 0;color:var(--accent);font-size:14px}
.warn{width:100%;margin:0;color:var(--no);font-size:14px}
#toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translate(-50%,16px);opacity:0;background:var(--text);color:var(--bg);padding:12px 20px;border-radius:999px;font-weight:600;transition:opacity .2s,transform .2s;pointer-events:none}
#toast.show{opacity:1;transform:translate(-50%,0)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;
