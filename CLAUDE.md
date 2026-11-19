# Clipping tool — CLAUDE.md

Automatische clipping-tool voor streams en video's (Twitch, Kick, YouTube). De tool vindt de beste momenten, maakt verticale clips, post ze op TikTok, YouTube Shorts en Instagram Reels, en meldt ze aan bij clipping-campagnes (Content Rewards e.d.), waar per 1.000 views wordt betaald.

**Enige handmatige stap:** clips goedkeuren (✅/❌) via een Telegram-bot. Al het andere draait automatisch.

---

## Werkafspraken voor Claude

- **Vraag eerst** bij architectuurkeuzes, nieuwe dependencies en alles wat lastig terug te draaien is. Kleine implementatiekeuzes mag je zelf maken.
- Werk **per fase** (zie onder). Een fase is pas af als de acceptatiecriteria gehaald zijn.
- Houd modules los van elkaar: ze praten **alleen via de job-wachtrij en de database**. Dan kunnen lichte modules later naar een VPS verhuizen zonder herbouw.
- Schrijf tests voor de scoring en de campagne-check. Die bepalen of er geld binnenkomt.
- Commit geen secrets. Alles wat geheim is staat in `.env` (staat in `.gitignore`).
- **Design:** gebruik voor alle UI en UX (het dashboard, de opmaak van Telegram-berichten, en de visuele stijl van ondertitels en overlays in clips) de skill **UI UX Pro Max**. Laad die vóór je aan een scherm of visueel onderdeel begint. Is hij niet geïnstalleerd, meld dat dan en vraag of de gebruiker hem eerst wil toevoegen.
- **Micro-animaties mogen:** kleine, functionele animaties zoals hover- en klik-feedback, vloeiende overgangen tussen schermen, laadstatussen, en tellers die oplopen bij statistieken. Houd ze kort en subtiel, en respecteer `prefers-reduced-motion`.
- **Eerst de stack kiezen:** onderzoek vóór fase 0 wat de beste stack is, voor het hele project en vooral voor de UI en de animaties (bijvoorbeeld React + Vite met Tailwind, een componentbibliotheek, en een animatiebibliotheek zoals Motion). Leg 2–3 opties voor met de voor- en nadelen, en wacht op een keuze. De stack hieronder is gekozen op 2026-11-19 (optie B).

---

## Omgeving

- **OS:** Windows (native, geen WSL nodig)
- **Bekende hardware:** RTX 5070 (12GB VRAM), 32GB DDR4. **Altijd eerst controleren met stap 0.**
- **Schijf: alles op E:, niets op C:.** Project in `E:\dev\clipping-tool`, werkmap (downloads, renders, opnames) in `E:\dev\clipping-tool\data`. Zet ook de grote caches op E: via `.env`: `HF_HOME=E:\dev\cache\huggingface` (Whisper-modellen), `OLLAMA_MODELS=E:\dev\cache\ollama`, `PIP_CACHE_DIR=E:\dev\cache\pip`, `TEMP` voor `ffmpeg` naar `E:\dev\cache\tmp`. Programma's die via `winget` worden geïnstalleerd mogen op C: blijven staan.
- **Draait nu op:** alleen de PC (optie A). Later eventueel een kleine VPS van 2–4GB voor de lichte modules (optie B).

### Voorbereiding — tools controleren (vóór stap 0)

De meeste tools zijn waarschijnlijk al geïnstalleerd. **Controleer eerst, installeer alleen wat ontbreekt, en vraag toestemming voordat je iets installeert.**

| Tool | Controle | Installeren als het ontbreekt |
|---|---|---|
| Node.js 20+ | `node --version` | `winget install OpenJS.NodeJS.LTS` |
| Python 3.11+ | `python --version` | `winget install Python.Python.3.12` |
| ffmpeg met NVENC | `ffmpeg -hide_banner -encoders \| findstr nvenc` (moet `h264_nvenc` tonen) | `winget install Gyan.FFmpeg` |
| yt-dlp | `yt-dlp --version` | `winget install yt-dlp.yt-dlp` |
| Git | `git --version` | `winget install Git.Git` |
| streamlink (fase 3) | `streamlink --version` | `winget install Streamlink.Streamlink` |
| TwitchDownloaderCLI | `TwitchDownloaderCLI --version` | Release van GitHub (lay295/TwitchDownloader) in `tools/` |

Na installeren: nieuwe terminal openen, zodat PATH is bijgewerkt. Geef daarna een kort overzicht: wat er al was, wat er is geïnstalleerd, en wat er nog ontbreekt.

**Keys die de gebruiker zelf regelt** (zet ze in `.env.example` als lege variabelen en vraag erom als ze nodig zijn; nooit in de chat laten plakken of committen):

- `TELEGRAM_BOT_TOKEN`: via `/newbot` bij @BotFather
- `TELEGRAM_CHAT_ID`: bot een bericht sturen, dan `https://api.telegram.org/bot<token>/getUpdates`
- `TWITCH_CLIENT_ID` en `TWITCH_CLIENT_SECRET`: app aanmaken op dev.twitch.tv/console (voor de Clips API)

Commit na elke afgeronde fase.

### Stap 0 — Hardware-check (altijd als eerste)

Voer bij de start van het project uit en schrijf het resultaat naar `config/hardware.json`:

```powershell
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory
Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores
Get-PSDrive -PSProvider FileSystem
ffmpeg -hide_banner -encoders | findstr nvenc
python --version; node --version
```

Leid hieruit af en sla op in `config/hardware.json`:

- `whisperModelVod`: `large-v3` bij ≥10GB VRAM, anders `medium`
- `whisperModelLive`: `large-v3-turbo` (lichter, voor live en tijdens gamen; `distil-large-v3` is alleen Engels)
- `encoder`: `h264_nvenc` als NVENC beschikbaar is, anders `libx264`
- `maxParallelRenders`: op basis van VRAM en cores
- `workDir`: altijd op E: (`E:\dev\clipping-tool\data`). Controleer de vrije ruimte op E: en of het een SSD is; waarschuw als er minder dan ~100GB vrij is.

De tool controleert dit ook bij elke start (`core/hardware.ts`) en waarschuwt bij afwijkingen.

---

## Stack

| Laag | Keuze |
|---|---|
| Kern, wachtrij, bot, dashboard | Node.js 22.18+ + TypeScript (draait direct via type stripping, npm workspaces) |
| Database | SQLite + Drizzle ORM + `better-sqlite3` (WAL) |
| Wachtrij | Eigen job-tabel in SQLite, atomair claimen met één `UPDATE … RETURNING` (geen Redis) |
| ML en analyse | Python 3.12 in `.venv` (systeem-Python 3.14 mist wheels): `faster-whisper`, `mediapipe`, `numpy` |
| Media | `ffmpeg` (met NVENC), `yt-dlp`, `streamlink`, TwitchDownloaderCLI (chat-replay) |
| Telegram | `grammY` |
| API voor dashboard | Fastify |
| Dashboard (fase 4) | React + Vite + Tailwind v4 + shadcn/ui + Motion + TanStack Query |
| Titels en hooks | Lokaal via Ollama, of Claude Haiku via de API (instelbaar) |

Node roept Python-workers aan als losse processen, met JSON in en uit via de command line of stdin. Geen gedeelde state.

---

## Projectstructuur

```
clipping-tool/
├─ CLAUDE.md
├─ .env.example
├─ config/
│  ├─ hardware.json        # gegenereerd door stap 0
│  ├─ streamers.yaml       # per streamer: platform, kanaal, facecam-positie, tag, campagne
│  └─ settings.yaml        # drempels, limieten, platforms aan/uit
├─ requirements.txt       # Python-workers (.venv, Python 3.12)
├─ tools/                 # TwitchDownloaderCLI.exe (niet in git)
├─ apps/
│  ├─ core/                # Node: scheduler, wachtrij, modules
│  │  └─ src/
│  │     ├─ hardware.ts
│  │     ├─ doctor.ts       # npm run doctor
│  │     ├─ db/             # Drizzle-schema + client (migraties in apps/core/drizzle/)
│  │     ├─ queue/          # job-tabel, workers, retries
│  │     ├─ modules/
│  │     │  ├─ scout/       # fase 4
│  │     │  ├─ watcher/
│  │     │  ├─ vod-clipper/
│  │     │  ├─ live-clipper/  # fase 3
│  │     │  ├─ editor/
│  │     │  ├─ compliance/  # campagne-check
│  │     │  ├─ publisher/
│  │     │  ├─ submitter/
│  │     │  ├─ tracker/
│  │     │  └─ learner/
│  │     └─ telegram/
│  └─ dashboard/           # fase 4
├─ workers/                # Python
│  ├─ transcribe.py        # faster-whisper met timing per woord
│  ├─ music_detect.py      # achtergrondmuziek herkennen
│  ├─ face_track.py        # MediaPipe, voor video's zonder vaste facecam
│  └─ analyze_clip.py      # hook, lengte, tempo (voor de Learner)
└─ data/                   # werkmap: downloads, renders (niet in git)
```

---

## Datamodel (Drizzle, globaal)

- `Streamer` — naam, platform, kanaal-id, config uit `streamers.yaml`
- `Campaign` — platform (Content Rewards, enz.), streamer, tarief per 1K, max per clip, pool, resterend budget, einddatum, regels (JSON), status
- `Source` — VOD of video: url, streamer, duur, status
- `Moment` — source, start, eind, score, signalen (JSON), status
- `Clip` — moment, bestandspad, lengte, hook, titel, compliance-resultaat, status (`pending_review` / `approved` / `rejected` / `posted`)
- `Post` — clip, platform, account, url, geplaatst op, aangemeld bij campagne (ja/nee)
- `Stat` — post, views, likes, gemeten op
- `Job` — type, payload (JSON), status, pogingen, fout, gepland op

---

## De pipeline

1. **Scout** zoekt campagnes en zet ze in `Campaign`. *(fase 4; tot die tijd vul je campagnes handmatig in via `streamers.yaml`)*
2. **Watcher** ziet nieuwe VODs en video's, en wie er live gaat.
3. **Clipper** kiest de momenten.
   - Achteraf: chat-replay, de YouTube-heatmap, en Twitch-clips die kijkers zelf maakten (Clips API, `vod_offset`).
   - Live: chatpieken in realtime, met een opnamebuffer.
4. **Editor** maakt de clip: 9:16 (facecam boven, gameplay onder), ondertitels woord voor woord, hook, tag of watermerk van de streamer, stiltes eruit, muziek zachter of vervangen.
5. **Compliance** controleert de clip tegen de campagnebrief. Een clip die niet voldoet gaat niet door.
6. **Telegram** stuurt de clip naar jou met ✅/❌.
7. **Publisher** post de goedgekeurde clips met per platform een eigen titel, hook en onderschrift.
8. **Submitter** meldt de link binnen 30 minuten aan bij de campagne.
9. **Tracker** meet de views per post en de opbrengst per campagne.
10. **Learner** gebruikt die views, analyseert wekelijks de top-clips van anderen, voert A/B-tests uit en stelt de drempels bij.

### Scoring (achteraf)

Per tijdvenster van 5 seconden:

- `chatRate`: berichten per seconde als z-score ten opzichte van de baseline van die stream
- `emoteScore`: gewogen telling van emotes (`LUL`, `KEKW`, `OMEGALUL`, `Pog`, enz.); de gewichten staan in de config
- `viewerClipHits`: aantal Twitch-clips van kijkers die dit moment overlappen. Dit is een sterk signaal.
- `audioPeak`: piek in volume

Totale score = gewogen som (gewichten in `settings.yaml`, later bijgesteld door de Learner). Neem de top-N pieken, met **30–60 seconden vóór** de piek (de chat reageert later dan het moment), en voeg overlappende vensters samen. Houd de lengte binnen de limieten van de campagne en het platform.

---

## Regels (hard: nooit omzeilen)

- **Alleen streamers met een lopende campagne** of met schriftelijke toestemming.
- **Geen Kick-gokcampagnes** en geen gokcontent.
- **Geen nepviews**, geen gekochte of gefarmde accounts.
- **Geen reuploads** van clips van andere clippers. Altijd zelf het moment vinden en bewerken.
- **Disclosure** aan het begin van elke clip als de campagne dat vraagt (standaard aan).
- **Tag of watermerk** van de streamer volgens de brief.
- **Muziek** van derden zachter zetten, vervangen of de clip blokkeren.
- **Geen Discord-selfbots** en geen scraping van TikTok of Instagram. Alleen officiële API's. Waar geen API is: melding naar Telegram.
- **Limieten:** maximaal X posts per account per dag (`settings.yaml`), en een noodstop via Telegram (`/pause`, `/resume`).

---

## Fases en acceptatiecriteria

### Fase 0 — Fundament
- Stap 0 (hardware-check) → `config/hardware.json`
- Repo-structuur, Prisma-schema, job-wachtrij met retries en logging
- `.env.example` met alle benodigde keys
- **Klaar als:** `npm run doctor` hardware, tools (`ffmpeg`, `yt-dlp`, Python-pakketten) en keys controleert en een duidelijk rapport geeft.

### Fase 1 — MVP: VOD → clip → Telegram
- Watcher (alleen Twitch, alleen VODs)
- VOD Clipper: download + chat-replay + Twitch Clips API → scoring → top-N momenten
- Editor: facecam/gameplay-layout per streamer, NVENC, Whisper-ondertitels (`.ass`, woord voor woord), tag of watermerk, disclosure
- Telegram-bot: clip met ✅/❌, plus `/pause`, `/resume`, `/status`; foutmeldingen bij mislukte jobs
- Goedgekeurde clips komen in `data/approved/` (posten nog handmatig)
- **Klaar als:** één Twitch-VOD-URL leidt automatisch tot 5–10 clips in Telegram, binnen een redelijke tijd voor een VOD van 3 uur.

### Fase 2 — Automatisch posten en verdienen
- Compliance-check, muziekdetectie
- Publisher (TikTok en Shorts eerst, Instagram later), met variatie per platform
- Submitter, Tracker, budget per campagne bijhouden, dubbele momenten voorkomen
- **Klaar als:** een goedgekeurde clip zonder verdere handelingen op 2 platforms staat, is aangemeld bij de campagne en views laat zien in `/status`.

### Fase 3 — Live en meer bronnen
- Live Clipper (`streamlink`-buffer + chat via IRC + piekdetectie + lichte Whisper)
- Kick en YouTube als bronnen (chat-replay, heatmap)
- Zware jobs automatisch pauzeren zolang er een game draait (instelbaar)

### Fase 4 — Slimmer
- Scout (campagnes vinden waar dat legaal kan; de rest als melding)
- Learner: top-clips van anderen (Twitch Clips API, YouTube Data API), A/B-tests op hooks en titels, drempels automatisch bijstellen
- Dashboard (React): campagnes, clips, opbrengst per streamer, ontworpen met UI UX Pro Max en met micro-animaties

---

## Veiligheid en beheer

- Secrets in `.env` of Windows Credential Manager; nooit in logs.
- Dagelijkse back-up van de SQLite-database naar een tweede map of schijf.
- Bronvideo's automatisch verwijderen zodra de clips klaar zijn (instelbaar hoe lang ze bewaard blijven).
- Elke job heeft retries met backoff. Na de laatste mislukte poging gaat er een melding naar Telegram.
