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
- [ ] Let the Ollama app start at login (Start menu > Ollama, it adds itself to startup). Set the user environment variable `OLLAMA_MODELS=E:\dev\cache\ollama` first, or it downloads the models again to C:.
  Without Ollama, clips still work, but get a plain fallback title.

## Zernio (TikTok and Instagram posting through their audited app)
- [ ] Create a free account at https://zernio.com (first 2 social accounts free, no card).
- [ ] Dashboard > API keys > Create API key. Put it in `.env` as `ZERNIO_API_KEY=` (never in chat).
- [ ] Connect the TikTok test account (new connections use TikTok's Business app: posts are public, max 15 videos per day).
- [ ] Tell Claude when done: the first API test checks whether a free workspace may post. The docs disagree: the pricing page says "no credit card required", but the rate-limits page says writes without billing return `402 workspace_billing_required`.
- Rules to know (https://zernio.com/content-guidelines): "Only post content you have rights to use", and no "duplicate or substantially similar content". Post each clip once per account. Campaign clips are allowed by the streamer's campaign.
