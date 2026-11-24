# To do (owner)

Things only the owner can do. Checked against the official docs on 2026-11-24.

## YouTube
- [ ] Google Cloud > OAuth consent screen > Audience: set the publishing status to **In production**.
  In "Testing", refresh tokens expire after 7 days, so every account would need a reconnect each week.
  Unverified production apps show a warning on login ("Google hasn't verified this app"): click Advanced > continue. That is fine for your own accounts.
- [ ] Create an API key in the same project (Credentials > API key) and paste it on the Accounts page. It checks if a name is free.
- [ ] First upload test: check that the video is public. Google says (revision history, 2 Nov 2026) that uploads from unverified projects are no longer forced to private.
  If it is still locked as private, apply for the YouTube API Services audit.

## TikTok
- [ ] Direct Post audit (needed for public auto-posting): https://developers.tiktok.com/application/content-posting-api
  The rules exclude this tool: "A utility tool to help upload contents to the account(s) you or your team manages" is listed as not acceptable, and "Apps must not be for private or personal use."
  Only apply if the tool is offered to other clippers (a real website, privacy policy and terms visible on it, a demo video of the full flow).
- Until then (unaudited): at most 5 users per 24 h, the posting account must be private, and posts are SELF_ONLY.

## Ollama (titles)
- [x] Repair Ollama (done 2026-11-24: reinstalled 0.40.18, runs on the GPU, ~126 tokens/s instead of ~9 on the CPU).
- [x] Ollama app starts at login (Startup folder) and user variable `OLLAMA_MODELS=E:\dev\cache\ollama` is set (2026-11-24).
  After the next login, check that Ollama still lists gemma4:12b (`ollama list`); if not, it is looking on C:.
  Without Ollama, clips still work, but get a plain fallback title.

## PostPeer (first choice for TikTok and Instagram posting, checked 2026-11-24)
Free: 20 credits (1 credit = 1 post), unlimited connected accounts, no card. TikTok posts are public by default (`PUBLIC_TO_EVERYONE`, DIRECT_POST) through PostPeer's own TikTok app.
- [ ] Create a free account at https://www.postpeer.dev.
- [ ] Connect 1 TikTok account and 1 Instagram account (Instagram must be business or creator).
- [ ] Create an API key. Put it in `.env` as `POSTPEER_API_KEY=` (never in chat). Tell Claude.
- Add the same account names on the Accounts page (TikTok, and Instagram Reels). Claude then turns on `platforms.tiktok` in settings.yaml, posts 1 test clip and checks that it is really public. If yes: stay on PostPeer.
  When the free credits run out, compare paid plans: PostPeer Starter ($23.10/mo billed yearly, 2,000 posts) vs Post for Me ($10/mo, 1,000 posts, unlimited accounts, https://www.postforme.dev/pricing).
- Do not create extra free accounts at one service to get more free posts: bundle.social's terms ban it, and others may close the account for it.

## Buffer (backup, checked 2026-11-24)
Free plan: 3 channels, API included, auto-publish to TikTok business, Instagram business/creator and YouTube Shorts, max 10 queued posts per channel.
- [ ] Create a free account at https://buffer.com.
- [ ] Connect the TikTok account as a **business** account and Instagram as **business or creator** (personal Instagram only gets reminders, no auto-post).
- [ ] Create an API key at https://publish.buffer.com/settings/api. Put it in `.env` as `BUFFER_API_KEY=` (never in chat).
- [ ] Buffer has no upload endpoint: it fetches the video from a public URL. Plan: Tailscale Funnel serving only approved clips under a random link. Enable Funnel for this PC in the Tailscale admin console (Access controls > allow `funnel`), then tell Claude.

## Zernio (backup if Buffer fails)
- [ ] Create a free account at https://zernio.com (first 2 social accounts free, no card).
- [ ] Dashboard > API keys > Create API key. Put it in `.env` as `ZERNIO_API_KEY=` (never in chat).
- [ ] Connect the TikTok test account (new connections use TikTok's Business app: posts are public, max 15 videos per day).
- [ ] Tell Claude when done: the first API test checks whether a free workspace may post. The docs disagree: the pricing page says "no credit card required", but the rate-limits page says writes without billing return `402 workspace_billing_required`.
- Rules to know (https://zernio.com/content-guidelines): "Only post content you have rights to use", and no "duplicate or substantially similar content". Post each clip once per account. Campaign clips are allowed by the streamer's campaign.
- [ ] Silky: check the real end date on the campaign page after joining (config assumes 2026-11-30).
- [ ] YourRAGE: rules page not found (reachclipping.com/YourRAGE gives 404). Share the brief after joining, then I add him.
- [ ] YouTube Data API key (free), so I can study the layout of top Shorts from other clippers:
      Google Cloud console > same project as YouTube login > APIs & Services > Credentials > Create credentials > API key.
      Restrict it to "YouTube Data API v3". Put it in `.env` as `YOUTUBE_API_KEY=` (never in chat).
- [ ] Join ALL streamer clipping campaigns on Content Rewards (2026-11-24). Briefs, rules and channel names show only after joining.
      Then tell Claude; it reads each brief and adds the campaign (no gambling). Lowest pay bar first:
      - Dasgasd3m x RUCKUS GTA 6: $2/1K, min payout $20 (~10K views), max $150/clip, TikTok + YouTube, GTA 6-only account. https://contentrewards.com/c/campaigns/051002dd-5c46-43d0-a446-43f2957ba3a9
      - Michael Sartain: $1-2/1K (~5-10K views for $10), ~$4.2K left. https://contentrewards.com/c/campaigns/86842687-ba2b-4638-a024-995dcf3d25a3
      - BenDaDonnn x Puffco GTA 6: $1/1K, min $2. Puffco is a vape brand: your call. https://contentrewards.com/c/campaigns/bb66f9eb-b90e-4dd0-8cee-9f3cd566c9a0
      - Kai Cenat GTA 6: $10K pool, 3.1K clippers. https://contentrewards.com/c/campaigns/1d2bcb00-c904-415f-aa82-f95b96baad86
      - Rest of the 100+ list at https://contentrewards.com/c/discover/clipping (skip gambling, e.g. 1WIN, VAVADA).
