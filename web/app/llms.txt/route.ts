export async function GET(req: Request) {
  const base = (process.env.TROVE_PUBLIC_URL || new URL(req.url).origin).replace(/\/$/, '');
  const body = `# Trove

> A personal library (Raindrop-style read-later and archive, stored in Notion). Agents can save links, notes, images, videos, audio and documents, and search what was saved.

Auth for everything below: \`Authorization: Bearer <TROVE API KEY>\` (ask the user for a key; never print it).

## CLI (simplest for agents that can run commands)
npm install -g github:medpar/trove
trove login --url ${base} --key <key>        # or set TROVE_URL and TROVE_API_KEY
trove save <url|text> [-t tags] [-c Collection] [-n note] --json
trove upload <file…> [-t tags] [-c Collection] [-n note] [--title "…"] [-d "what it shows"] --json   # images, videos, audio, PDFs, up to 1 GB
trove search "<query>" [-l N] [--unsorted] [--untagged] --json
trove get <id> --content --json
trove update <id…> [--add-tags a,b] [-c Collection] [--read] --json
trove check <url> --json
trove tags --json | trove collections --json
Run \`trove --help\` for everything.

## When you save something
File it without asking: list existing collections and tags first (trove collections --json, trove tags --json, or GET /api/stats), pass the best collection (nested with "/"; create one only when nothing fits; never "Browser bookmarks", "X bookmarks" or "Pinterest", which Trove fills itself), 1-4 short lowercase tags, and a one-line note when the user gave context. Write collection names, tags, notes and any title you set in English, even if the content or request is in another language. Trove detects the content type (article, video, X bookmark, repo...) itself. For a file, set a real title when its name is meaningless (IMG_2041.jpg) and describe what it shows in "description" so search finds it.

## REST
- POST ${base}/api/items  JSON {url | text, title?, note?, tags?, collection?, highlight?, favorite?}  -> saves (deduplicated; saving again merges tags and notes). {items:[...]} saves up to 25 at once.
- GET  ${base}/api/items?q=QUERY&limit=20  -> search. Syntax: words, "phrase", -word, #tag, -#tag, type:video|article|post|x|repo|note (type:x = X bookmarks), site:domain, collection:"Name", is:fav, is:unread, created:>2025-01, source:x, match:OR
- GET  ${base}/api/items/{id}?content=1  -> item + archived Markdown (article text, transcript, post)
- PATCH ${base}/api/items/{id}  {tags, collection, note, favorite, read, title}
- POST ${base}/api/files  -> save an image, video, audio file or document (deduplicated by content). Up to 4 MB per request, as one of:
    multipart/form-data with a "file" field (+ title, description, note, tags, collection, url, favorite)
    raw bytes with Content-Type and ?filename=NAME&tags=...&collection=...
    JSON {data: "<base64 or data: URL>", filename, ...} | {file_url: "<public direct link>", ...} | {upload: "<token>", ...}
- POST ${base}/api/files/uploads  JSON {filename, size, content_type?, sha256?}  -> for files over 4 MB (up to 1 GB): returns {upload, put: {url, headers}}.
    PUT the raw bytes to put.url sending every put.headers entry, then POST /api/files {"upload": "<upload>", title, tags, collection, note}.
    If sha256 matches a file saved before you get {duplicate: true, item} instead and nothing needs uploading.
- GET  ${base}/api/lookup?url=...  -> which URLs are already saved
- GET  ${base}/api/stats  -> collections, tags and counts
- OpenAPI: ${base}/openapi.json

## MCP (optional)
- Streamable HTTP server: ${base}/api/mcp with the same bearer key
- Tools: save, save_many, save_file, create_upload, search, get_item, update_item, add_highlight, delete_item, check_saved, list_collections, list_tags, rename

## Examples
curl -X POST ${base}/api/items -H "Authorization: Bearer $TROVE_API_KEY" -H "content-type: application/json" -d '{"url":"https://example.com/post","tags":["ai"],"note":"why it matters"}'
curl "${base}/api/items?q=%23ai+type:article&limit=5" -H "Authorization: Bearer $TROVE_API_KEY"
curl -X POST ${base}/api/files -H "Authorization: Bearer $TROVE_API_KEY" -F file=@screenshot.png -F title="Checkout redesign" -F description="what it shows" -F tags=ui,design -F collection="Design/Screenshots"

# A video over 4 MB, in three requests
curl -X POST ${base}/api/files/uploads -H "Authorization: Bearer $TROVE_API_KEY" -H "content-type: application/json" -d '{"filename":"demo.mp4","size":52428800}'
curl -X PUT --data-binary @demo.mp4 "<put.url>" -H "x-api-version: 13" -H "x-vercel-blob-access: private" -H "x-content-type: video/mp4"
curl -X POST ${base}/api/files -H "Authorization: Bearer $TROVE_API_KEY" -H "content-type: application/json" -d '{"upload":"<upload>","title":"Product demo","collection":"Work/Demos"}'
`;
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
