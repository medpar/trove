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
- **One Notion database for everything.** `Trove` holds everything you save. Your X bookmarks live in it as their own type, **X bookmark**, in the **X bookmarks** collection, filled automatically by the extension (full threads, reply context, media, likes and views). Browser bookmarks go to **Browser bookmarks** and Pinterest saves to **Pinterest**, each with their folders or boards inside.
- **Never a duplicate.** URLs are normalized (tracking params, `www`, mobile hosts, `youtu.be`, `?s=20`, arXiv versions…). Saving again merges tags, notes and highlights instead.
- **Organize like Raindrop.** Nested collections (`Dev/AI`), tags, favorites, read-later, notes, highlights, reminders, broken-link detection, bulk edit, four views (cards, list, headlines, moodboard), keyboard-first UI, light & dark themes.
- **Search with operators:** `"phrase"`, `-word`, `#tag`, `-#tag`, `type:video`, `site:github.com`, `collection:"Dev/AI"`, `is:fav`, `is:unread`, `created:>2025-01`, `highlights:true`, `source:x`, `match:OR`.
- **Free.** Vercel Hobby + your Notion workspace + Cloudflare DNS. No paid APIs.

## Save from everywhere

| Where | How |
|---|---|
| **Web app** (any OS) | Paste a link anywhere (⌘V), drop it on the window, or press <kbd>N</kbd>. Add many links at once, or a plain note. |
| **Brave / Chrome / Edge / Arc** (macOS, Windows, Linux) | The extension: toolbar button, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>, right-click page / link / image / **selection → highlight**. It reads the page you're on, so logged-in and paywalled pages are archived too. Imports all browser bookmarks (folders → collections) and can auto-save new ones. Keeps syncing your **X bookmarks** with threads and media. |
| **Pinterest** | The extension imports every pin on your boards (secret ones and quick saves too) with its image archived, one sub-collection per board, and keeps them in sync every few hours. Uses your Pinterest login in the browser; no API keys. |
| **iPhone, iPad, Mac** | The signed **“Save to Trove” Shortcut** (Share sheet in every app + macOS Share menu / Services). It asks for your API key once. |
| **Android, Windows, ChromeOS** | Install the app (PWA) → it appears in the system share sheet. |
| **Any browser** | Bookmarklet (Settings → drag “＋ Save to Trove”); selected text becomes a highlight. |
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
extension/    Brave/Chrome MV3 extension: save pages/links/images/highlights, browser bookmarks, X bookmarks sync (local, uses your x.com session)
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
2. **Vercel:** create a project with root directory `web`, and set `NOTION_TOKEN`, `TROVE_LIBRARY_DS`, `TROVE_LIBRARY_DB`, `TROVE_PASSWORD`, `TROVE_SESSION_SECRET`, `TROVE_API_KEYS` (`Name:key,Name:key`), `TROVE_PUBLIC_URL`, `CRON_SECRET`. For file uploads over 4 MB, connect a private Blob store (`vercel blob create-store trove-uploads --access private`, which sets `BLOB_READ_WRITE_TOKEN`; the free tier is plenty, since staged files are deleted once they are in Notion). Deploy.
3. **Extension:** load `extension/` unpacked (or the release zip), then set the app URL + API key in its settings.
4. **Shortcut:** `python3 scripts/make-shortcut.py https://your-app web/public/trove.shortcut` then `shortcuts sign --mode anyone …`.

## Development

```bash
npm test                          # extension + web logic, Notion limits, end-to-end sync against mocks
npm --prefix web run dev          # web app on :3000 (needs web/.env.local)
node scripts/live-check.mjs       # smoke test against the real Notion API
node scripts/package.mjs          # extension zip
```

## License

MIT
