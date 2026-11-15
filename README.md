<p align="center"><img src="docs/icon.png" width="88" alt="Trove logo"></p>

<h1 align="center">Trove</h1>

<p align="center"><b>Save anything, keep everything.</b><br>
A personal, Raindrop-style library that archives what you save (articles, videos, social posts, repos, papers, notes, images and files, browser bookmarks and your X bookmarks) into Notion, so nothing is lost when the original disappears. With a CLI and API for agents, and a built-in librarian agent that runs on your own Claude or ChatGPT subscription.</p>

<p align="center">
  <a href="https://trove.mariomedpar.com">App</a> ·
  <a href="https://github.com/medpar/trove/releases/latest">Extension</a> ·
  <a href="#save-from-everywhere">Capture</a> ·
  <a href="#ai-agents">AI agents</a> ·
  <a href="#self-hosting">Self-host</a>
</p>

---

## What it does

- **Archives the content, not just the link.** Articles are stored as clean text (Readability), YouTube videos with description and transcript, X/Reddit/Bluesky/Mastodon/Hacker News posts with their text and media, GitHub repos with their README, arXiv papers with abstract and the PDF, any PDF or image file. Covers and media are copied into Notion's file storage.
- **One Notion database for everything.** `Trove` holds everything you save. Your X bookmarks live in it as their own type, **X bookmark**, in the **X bookmarks** collection, filled automatically by the extension (full threads, reply context, media, likes and views). Browser bookmarks go to **Browser bookmarks** and Pinterest saves to **Pinterest** and your GitHub stars to **GitHub stars**, each with their folders or boards inside where they have them.
- **Never a duplicate.** URLs are normalized (tracking params, `www`, mobile hosts, `youtu.be`, `?s=20`, arXiv versions…). Saving again merges tags, notes and highlights instead.
- **Organize like Raindrop.** Nested collections (`Dev/AI`), tags, favorites, read-later, notes, highlights, reminders, broken-link detection, bulk edit, four views (cards, list, headlines, moodboard), keyboard-first UI, light & dark themes.
- **Search with operators:** `"phrase"`, `-word`, `#tag`, `-#tag`, `type:video`, `site:github.com`, `collection:"Dev/AI"`, `is:fav`, `is:unread`, `created:>2025-01`, `highlights:true`, `source:x`, `match:OR`.
- **AI that files for you.** New saves land in the right collection with tags and a one-line summary, chosen from your own taxonomy. Search by meaning (“that post about pricing dev tools”), ask questions answered from your library with sources, and see related items. Images, screenshots and scanned PDFs are read with OCR so their text is searchable. Runs free on Cloudflare Workers AI (`workers/ai`): Qwen3 for filing and answers, Llama 4 Scout for OCR, BGE-M3 multilingual embeddings, all within the free daily allowance.
- **Web archive.** Every page gets a self-contained snapshot (HTML with styles and images) stored in your Notion, plus a Wayback Machine capture. When a link dies, the archived page is one click away.
- **Reader.** Reading progress that syncs across devices, listen (text-to-speech), adjustable text size, highlights with notes.
- **Feeds.** Follow blogs, Substacks, YouTube channels and any RSS/Atom feed (OPML import). Posts wait in Feeds until you save them, or auto-save into a collection.
- **Shows: never lose your place in a podcast.** What you watch on YouTube and listen to on Spotify, on any device, in one record per episode: what you actually played (seeks and ads don't count), where you stopped, and whether you finished, whichever platform it was. The video and the episode of the same show are paired, shows are split into series (from the channel's YouTube playlists, even when Spotify has none), and youtube.com and open.spotify.com mark what you've seen. Phone and tablet listening comes in through your own Spotify and YouTube sign-ins (no Premium, no API keys). See [docs/shows.md](docs/shows.md).
- **Backups.** A nightly GitHub Action mirrors the library to Markdown + JSON in a private repo (`trove backup`).
- **Free.** Vercel Hobby + your Notion workspace + Cloudflare (DNS, email routing, Workers AI free tier).

## Save from everywhere

| Where | How |
|---|---|
| **Web app** (any OS) | Paste a link anywhere (⌘V), drop it on the window, or press <kbd>N</kbd>. Add many links at once, or a plain note. |
| **Brave / Chrome / Edge / Arc** (macOS, Windows, Linux) | The extension: toolbar button, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>, right-click page / link / image / **selection → highlight**. It reads the page you're on, so logged-in and paywalled pages are archived too. Imports all browser bookmarks (folders → collections) and can auto-save new ones. Keeps syncing your **X bookmarks** with threads and media. |
| **Pinterest** | The extension imports every pin on your boards (secret ones and quick saves too) with its image archived, one sub-collection per board, and keeps them in sync every few hours. Uses your Pinterest login in the browser; no API keys. |
| **Telegram** (every device) | Send or forward anything to your bot: links, text, photos, videos, voice notes, files. For a YouTube video or Spotify episode it also tells you whether you already watched or heard it, on either platform. `#tags`, `@Collection`, `!fav` in the message; buttons to move, tag, favorite or delete; reply to a card to edit it. `? query` searches, `?? question` asks, `@yourbot query` shares a saved link in any chat, and mentioning the bot in a reply in any chat saves that message. On iPhone, iPad and Mac, Share → Telegram → your bot works from every app. |
| **iPhone, iPad, Mac** | Four signed Shortcuts (Settings → Ways to save): **Save to Trove** (Share sheet: links, pages, text, photos, PDFs, files), **Save to Trove with Details** (pick collection, tags, note), **Trove Quick Save** (clipboard; for the Action Button, Back Tap, Control Center, Siri and a Mac hotkey) and **Trove Note** (dictate a thought). Each asks for your API key once. |
| **Email** | Send or forward to your Trove address: links become links, newsletters become articles, attachments become files; `#tags @Collection` in the subject. Cloudflare Email Routing → `workers/email` → `/api/inbound/email`. |
| **Raycast** (Mac) | `raycast/`: save the front tab or clipboard, search by meaning with previews, ask your library. |
| **Feeds** | RSS, Atom, Substack, YouTube channels, OPML. |
| **GitHub stars** | Every repo you star is saved to the **GitHub stars** collection with its README, twice a day (`GITHUB_STARS_USER`, optional `GITHUB_TOKEN`). |
| **Android, Windows, ChromeOS** | Install the app (PWA) → it appears in the system share sheet. |
| **Any browser** | Bookmarklet (Settings → Ways to save → drag “Save to Trove”); selected text becomes a highlight. |
| **Terminal, scripts & AI agents** | `trove` CLI, REST API, MCP: see below. Agents can also upload images, videos, audio and documents. |

## AI agents

Trove is built to be driven by agents: anything that can run a command or make an HTTP request can save to it and search it. No agent-specific setup; give it the CLI or the API and a key from Settings (the key's name is recorded as **Via**).

- **CLI** (zero dependencies, Node 20+):
  ```bash
  npm install -g github:medpar/trove
  trove login --key <api key>              # or set TROVE_URL and TROVE_API_KEY
  trove save https://example.com -t ai -n "why it matters"
  trove search '#ai type:article' --json
  trove get <id> --content                 # archived Markdown
  trove update <id> --add-tags ai -c "Dev/AI"
  trove upload ./screenshot.png ./demo.mp4 -c Design -t ui   # images, videos, audio, PDFs, up to 1 GB
  ```
  Every command takes `--json`. The [skill file](skills/trove/SKILL.md) teaches any skills-aware agent when and how to use it, including filing what it saves (collection, tags and a note) on its own.
- **REST:** `POST /api/items {url | text, tags, collection, note, highlight}`, `GET /api/items?q=…`, `GET /api/items/:id?content=1`.
- **Files:** `POST /api/files` with a multipart `file` (or raw bytes, base64 `data`, or a public `file_url`) up to 4 MB. Bigger files (up to 1 GB): `POST /api/files/uploads {filename, size}` returns a presigned URL; `PUT` the bytes there, then `POST /api/files {upload}`. The server streams the file into Notion and deletes the staged copy. Same bytes again = merged, never duplicated. Docs: [`/llms.txt`](https://trove.mariomedpar.com/llms.txt), [`/openapi.json`](https://trove.mariomedpar.com/openapi.json).
- **MCP** (optional): `https://trove.mariomedpar.com/api/mcp` with `Authorization: Bearer <key>`. Tools include `save_file` (base64, URL or upload token) and `create_upload` for big files.

### Telegram bot setup

1. Create a bot with @BotFather, then set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (random) and `TELEGRAM_ALLOWED_USERS` (your numeric Telegram id) on Vercel.
2. Settings → Ways to save → Telegram → Reconnect (or `POST /api/telegram/setup`) sets the webhook, commands and descriptions.
3. Optional, in @BotFather: `/setinline` for `@bot query` search in any chat, and Bot Settings → Guest Chat Mode so mentioning the bot in any chat saves the message.

### Email setup

Deploy `workers/email` with `wrangler deploy` and `wrangler secret put TROVE_EMAIL_SECRET`, enable Cloudflare Email Routing on a subdomain (so your main domain's mail is untouched) and route an address to the worker. On Vercel set `TROVE_EMAIL_SECRET`, `TROVE_EMAIL_FROM` (allowed senders) and `TROVE_EMAIL_ADDRESS`.

### Built-in agent

Trove has its own librarian agent that searches, tags, sorts into collections, merges duplicate tags and summarizes what you saved. It runs **on your computer with your Claude Pro/Max or ChatGPT subscription** through Claude Code or Codex (account login, no API keys) and acts only through the `trove` CLI.

```bash
claude auth login            # or: codex login
trove agent "tag everything that has no tags"
trove agent install          # macOS: keep the local bridge running so the web app's Agent panel can use it
```

In the web app, open **Agent** (top bar, or ⌘K → “Ask the agent”). The page talks to the local bridge on `127.0.0.1:7878`, which only accepts requests from your Trove origin.

## Architecture

```
web/          Next.js 16 app on Vercel: UI, REST API, MCP server, cron (daily broken-link check, stale upload cleanup)
  lib/files.ts     File uploads (images, videos, audio, documents) -> Notion, large ones staged in Vercel Blob
  lib/extract.ts   URL -> metadata + archived Markdown (Readability, YouTube, FxTwitter, Reddit, Bluesky, Mastodon, HN, GitHub, arXiv, oEmbed)
  lib/store.ts     Notion data layer: search -> filters, pagination, saves, highlights, stats
  app/api/mcp      MCP tools for agents
  lib/enrich.ts    After a save: OCR, AI filing + summary, embedding, web archive (snapshot + Wayback)
  lib/semantic.ts  Hybrid search, related items, Ask (embeddings stored in Notion, cached in Blob)
  lib/bot.ts       Telegram bot (webhook at /api/telegram)
  lib/email.ts     Email to Trove (/api/inbound/email)
  lib/feeds.ts     RSS/Atom subscriptions
  lib/episodes.ts  Shows: one Notion page per episode (YouTube + Spotify), progress merged across platforms
  lib/shows.ts     Followed shows: both catalogs paired, series from YouTube playlists and title rules
  lib/media-sync.ts  Hourly server sync of Spotify (web player API) and YouTube (watch history) progress
workers/email/  Cloudflare Email Routing worker that relays mail to Trove
workers/ai/     Free OpenAI-compatible relay to Cloudflare Workers AI (filing, OCR, embeddings)
raycast/        Raycast extension
extension/    Brave/Chrome MV3 extension: save pages/links/images/highlights, browser bookmarks, X bookmarks sync (local, uses your x.com session),
              progress tracking and marks on youtube.com and open.spotify.com
cli/          `trove` CLI and the local agent (Claude Code / Codex engines, bridge for the web app)
skills/trove/ Agent skill
scripts/      Notion setup, Apple Shortcut builder, icons, live checks
```

- Notion is the database: everything is yours, viewable and editable in Notion (Gallery, Read later, Favorites, Videos, Articles, Notes views are created for you).
- Media is imported by Notion's servers (`external_url` uploads); the browser downloads nothing.
- The X sync runs inside the extension with your own x.com session (no paid X API). See [How the X sync works](#how-the-x-sync-works).

### How the X sync works

X's web API rotates query ids, feature flags and an `x-client-transaction-id`. The extension records the request templates your own x.com tabs send (via `webRequest`, no content scripts) and also reads current query ids from x.com's bundle; it replays them from the service worker with your cookies. Bookmarks are archived within seconds of bookmarking on x.com and every 30 minutes; a full, resumable backfill covers your whole history.

## Self-hosting

1. **Notion:** `node scripts/setup-trove.mjs` creates the Trove database with every column, X bookmarks included (uses `NOTION_TOKEN` or the `ntn` CLI login). Coming from an older version with a separate X Bookmarks database? `node scripts/merge-x-into-trove.mjs` moves those pages in, keeping their content and media.
2. **Vercel:** create a project with root directory `web`, and set `NOTION_TOKEN`, `TROVE_LIBRARY_DS`, `TROVE_LIBRARY_DB`, `TROVE_PASSWORD`, `TROVE_SESSION_SECRET`, `TROVE_API_KEYS` (`Name:key,Name:key`; later keys can go in their own `TROVE_API_KEY_<NAME>` variables), `TROVE_PUBLIC_URL`, `CRON_SECRET`. For file uploads over 4 MB, connect a private Blob store (`vercel blob create-store trove-uploads --access private`, which sets `BLOB_READ_WRITE_TOKEN`; the free tier is plenty, since staged files are deleted once they are in Notion). Deploy.
3. **Extension:** load `extension/` unpacked (or the release zip), then set the app URL + API key in its settings.
4. **Shortcuts:** `python3 scripts/make-shortcut.py https://your-app` builds and signs all four.
5. **AI (optional, free):** deploy `workers/ai` with `wrangler deploy` and `wrangler secret put TROVE_AI_SECRET`, then set `AI_BASE_URL` (the worker URL + `/v1`), `AI_API_KEY` (the secret), `AI_MODEL=@cf/qwen/qwen3-30b-a3b-fp8`, `AI_VISION_MODEL=@cf/meta/llama-4-scout-17b-16e-instruct` and `AI_EMBED_MODEL=@cf/baai/bge-m3`. Optionally `wrangler secret put TROVE_ENRICH_KEY` with a Trove API key: the worker then asks Trove every hour to process items still waiting for AI (imports, syncs, saves made while AI was paused). On the Workers Free plan it stops at 10,000 neurons a day (about 500 items when most need OCR, many more when they don't) and resumes at 00:00 UTC; it can't bill. Without `AI_BASE_URL`, Trove uses Vercel AI Gateway (needs a card). `TROVE_AI=off` turns AI off.
6. **Shows (optional):** connect your Spotify and YouTube sign-ins (extension settings → YouTube & Spotify, or Trove → Settings → Shows) and redeploy `workers/ai` so its hourly cron also syncs them. Details in [docs/shows.md](docs/shows.md).
7. **Backup (optional):** a private repo with `.github/workflows/backup.yml` running `trove backup library` nightly, a `TROVE_API_KEY` secret, and `TROVE_BACKUP_REPO` on Vercel to link it from Settings.

## Development

```bash
npm test                          # extension + web logic, Notion limits, end-to-end sync against mocks
npm --prefix web run dev          # web app on :3000 (needs web/.env.local)
node scripts/live-check.mjs       # smoke test against the real Notion API
node scripts/package.mjs          # extension zip
```

## License

MIT
