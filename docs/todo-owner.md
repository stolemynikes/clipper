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
