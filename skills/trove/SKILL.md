---
name: trove
description: Save links, notes, images, videos, audio and documents to the user's Trove library (a Raindrop-style read-later and archive stored in Notion) and search what they saved. Use when the user shares a link, a piece of content or a file to keep ("save this", "bookmark", "read later", "add to Trove", "keep this screenshot/photo/video", "remember this article/video/post", or a bare URL or attachment with no other request), when you produce an image, video or file the user wants kept, or when they ask to find, list, tag, organize or re-read something they saved. Not for browsing or summarizing a link the user doesn't want saved.
---

# Trove

Trove is the user's personal library. Saving a URL archives the content itself (article text, YouTube description and transcript, X/Reddit/Bluesky/Mastodon posts with media, GitHub README, arXiv abstract and PDF), so it survives if the original disappears. Files (images, videos, audio, PDFs and other documents) are uploaded into it too. Saving the same URL or the same file again never duplicates; it merges tags and notes.

## How to call it

Use the **`trove` CLI** (install once with `npm install -g github:medpar/trove`, then `trove login --key <key>`; it reads `TROVE_URL` and `TROVE_API_KEY` too). Add `--json` whenever you need to read the output.

```bash
trove save https://example.com/post -t ai,research -c "Research" -n "why it matters" --json
trove save https://a.com https://b.com --json        # several links, one item each
echo "a thought worth keeping" | trove save --json   # a note
trove search '#ai type:article' -l 10 --json
trove search --untagged -l 50 --json                 # also: --unsorted, --source x, -c "Collection"
trove get <id> --content --json                      # item + archived Markdown
trove update <id> [<id>…] --add-tags ai -c "Dev/AI" --read --json
trove upload ./shot.png -c "Design/Screenshots" -t ui -d "what it shows" --json   # image, video, audio, PDF… up to 1 GB
trove upload ./a.jpg ./b.mp4 -c "Trips/Japan" --json  # several files, one item each
cat render.png | trove upload - --filename render.png --json   # bytes from stdin
trove check https://example.com/post --json          # already saved?
trove tags --json ; trove collections --json
trove rename tag ml machine-learning
```

Without the CLI, use the REST API with the same key (never print it):

```bash
curl -sS -X POST "$TROVE_URL/api/items" -H "Authorization: Bearer $TROVE_API_KEY" -H "content-type: application/json" \
  -d '{"url":"https://example.com/post","tags":["ai"],"collection":"Research","note":"why it matters"}'
curl -sS "$TROVE_URL/api/items?q=%23ai+type:article&limit=10" -H "Authorization: Bearer $TROVE_API_KEY"
curl -sS "$TROVE_URL/api/items/ITEM_ID?content=1" -H "Authorization: Bearer $TROVE_API_KEY"
```

### Files (images, videos, audio, documents)

With the CLI, `trove upload <path>` (or `trove save <path>`) handles everything: type detection, big files, duplicates, and a poster frame and duration for videos when ffmpeg is installed. Without it:

```bash
# Up to 4 MB: send the file in one request (multipart form, or raw bytes with ?filename=)
curl -sS -X POST "$TROVE_URL/api/files" -H "Authorization: Bearer $TROVE_API_KEY" \
  -F file=@shot.png -F title="Checkout redesign" -F description="what it shows" -F tags=ui,design -F collection="Design/Screenshots"
# Base64 in JSON (when you hold the bytes, not a file): {"data": "<base64 or data: URL>", "filename": "shot.png", …}
# A public direct link Notion can download: {"file_url": "https://…/clip.mp4", …}

# Over 4 MB (videos): 1) ask for an upload URL, 2) PUT the bytes there, 3) save it
curl -sS -X POST "$TROVE_URL/api/files/uploads" -H "Authorization: Bearer $TROVE_API_KEY" -H "content-type: application/json" \
  -d '{"filename":"demo.mp4","size":52428800}'      # -> {upload, put: {url, headers}}; add "sha256" to skip files saved before
curl -sS -X PUT --data-binary @demo.mp4 "<put.url>" -H "x-api-version: 13" -H "x-vercel-blob-access: private" -H "x-content-type: video/mp4"   # send every put.headers entry
curl -sS -X POST "$TROVE_URL/api/files" -H "Authorization: Bearer $TROVE_API_KEY" -H "content-type: application/json" \
  -d '{"upload":"<upload>","title":"Product demo","tags":["demo"],"collection":"Work/Demos"}'
```

MCP clients use the `save_file` tool (`data` base64, `file_url` or `upload`) and `create_upload` for big files. File the file like anything else (collection, tags, a note), give it a real title when the file name is meaningless (`IMG_2041.jpg`, `image.png`), and put what it shows in `description` so it can be found by search.

Full reference: `$TROVE_URL/llms.txt` and `$TROVE_URL/openapi.json`. An MCP server is also available at `$TROVE_URL/api/mcp` for clients that prefer MCP.

## Rules

1. **Bare link, attachment or "save this": save it right away.** Don't ask for confirmation. An image, video or file the user sends or asks you to keep is uploaded with `trove upload` (or the files API), not saved as a link to a temporary URL.
2. **File everything you save, without asking.** Trove detects the content type (article, video, X bookmark, repo…) by itself; you choose where it goes:
   - Run `trove collections --json` and `trove tags --json` once per conversation and reuse what exists.
   - Pick the best collection (nested with `/`, e.g. `Dev/AI`). Create a new one only when nothing fits, and nest it under an existing parent when one makes sense. Never file anything into `Browser bookmarks`, `X bookmarks` or `Pinterest`: Trove fills those by itself from the browser, X and Pinterest.
   - Add 1–4 short lowercase tags, reusing existing ones.
   - Add a one-line note with why it matters when the user gave any context.
   - **Write everything in English**: collection names, tags, notes and any title you set, even when the content or the user's message is in another language (translate it). Leave the original title of a saved page as it is unless the user asks you to rename it.
   - Pass them all in the same save: `trove save <url> -c "Dev/AI" -t llm,agents -n "…"`. If you only learn what it is after saving (from the archived content), fix it with `trove update <id> -c … --add-tags …`.
3. **Collections** are one per item. A parent collection includes its sub-collections when you search with `-c` or `collection:"Name"`.
4. **Search syntax:** words, `"exact phrase"`, `-exclude`, `#tag`, `-#tag`, `type:article|video|post|x|repo|note|paper|image|audio|document` (`type:x` = X bookmarks), `site:github.com`, `collection:"Name"`, `is:fav`, `is:unread`, `created:>2025-01`, `highlights:true`, `match:OR`.
5. **Answer from the archive:** to summarize or quote something saved, read it with `trove get <id> --content` instead of fetching the web again.
6. **Report what the command confirmed:** the title, whether it was new or already saved, and the link `$TROVE_URL/?item=<id>`. Never claim a save that returned an error.
7. **Delete** only on an explicit request (`trove rm <id>` moves it to Notion's trash).
