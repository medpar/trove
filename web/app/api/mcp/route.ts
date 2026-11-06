// Remote MCP server (Streamable HTTP) so any agent (Claude Code, Hermes, Cursor, ChatGPT,
// custom assistants) can save to and search Trove. Auth: Authorization: Bearer <api key>.
import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { caller, unauthorized, type Caller } from '@/lib/auth';
import { addHighlight, getItem, invalidateStats, list, lookup, remove, renameFacet, save, stats, update, type Item } from '@/lib/store';
import { toSaveInput } from '@/lib/input';
import { createUpload, saveFile, type FileSource } from '@/lib/files';
import { decodeBase64, dataUrlType } from '@/lib/media';

export const maxDuration = 300;

const INSTRUCTIONS = `Trove is the user's personal read-it-later library and archive (Raindrop-style) backed by Notion.
Use it whenever the user shares a link or content and wants it kept ("save this", "bookmark", "read later", "remember this article", or simply sends a bare link with no other request).
- save: store a URL (articles, YouTube, X/Reddit/Bluesky/Mastodon posts, GitHub repos, PDFs...) or plain text as a note. Trove fetches title, description, cover, the full article text / transcript, and never creates duplicates (saving again merges tags/notes).
- search: find saved items. Query syntax: words, "exact phrase", -exclude, #tag, type:video|article|post|x|repo|note (type:x = X bookmarks), site:domain, collection:"Name", is:fav, is:unread, created:>2025-01, highlights:true.
- save_file: store an image, video, audio file or document (screenshots, generated images, recordings, PDFs). Pass base64 "data" (up to ~3 MB) or a public "file_url". For bigger files call create_upload, PUT the bytes to the returned URL (e.g. with curl), then call save_file with "upload". Saving the same file again merges instead of duplicating.
- get_item returns the archived full content (Markdown) for summarizing or answering questions.
File everything you save without asking: call list_collections and list_tags once, then pass the best existing collection (nested with "/", create one only when nothing fits; never "Browser bookmarks", "X bookmarks" or "Pinterest", which Trove fills itself), 1-4 short lowercase tags and, when the user gave context, a one-line note. Write collection names, tags, notes and any title you set in English, even if the content or request is in another language. Trove detects the content type itself. Report only what tool results confirm.`;

const brief = (i: Item) => ({
  id: i.id,
  title: i.title,
  url: i.url,
  type: i.type,
  platform: i.platform,
  collection: i.collection,
  tags: i.tags,
  note: i.note || undefined,
  excerpt: i.excerpt ? i.excerpt.slice(0, 240) : undefined,
  author: i.author || undefined,
  favorite: i.favorite || undefined,
  read: i.read,
  saved: i.created,
  notion: i.notionUrl,
});

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: `Error: ${(e as Error)?.message || e}` }] });

function build(who: Caller) {
  return createMcpHandler(
    (server) => {
      const saveShape = z.object({
        url: z.string().optional().describe('Link to save. Optional when saving plain text.'),
        text: z.string().optional().describe('Plain text / a message to save as a note, or text containing a single link.'),
        title: z.string().optional().describe('Override the fetched title.'),
        note: z.string().optional().describe('Your note about why it matters (Markdown).'),
        tags: z.array(z.string()).max(5).optional(),
        collection: z.string().optional().describe('Collection name; nested with "/", e.g. "Dev/AI".'),
        highlight: z.string().optional().describe('A quote from the content to keep as a highlight.'),
        favorite: z.boolean().optional(),
      });

      server.registerTool(
        'save',
        { title: 'Save to Trove', description: 'Save a link or a piece of content (note) to Trove. Returns the saved item and whether it already existed.', inputSchema: saveShape },
        async (args) => {
          try {
            const r = await save(toSaveInput({ ...args, source: 'Agent' }, who));
            invalidateStats();
            return ok({ created: r.created, item: brief(r.item) });
          } catch (e) {
            return fail(e);
          }
        },
      );

      server.registerTool(
        'save_many',
        { title: 'Save several items', description: 'Save up to 25 links/notes in one call.', inputSchema: z.object({ items: z.array(saveShape).min(1).max(25) }) },
        async ({ items }) => {
          const results = [];
          for (const it of items) {
            try {
              const r = await save(toSaveInput({ ...it, source: 'Agent' }, who));
              results.push({ created: r.created, item: brief(r.item) });
            } catch (e) {
              results.push({ error: (e as Error).message, input: it.url || it.text?.slice(0, 60) });
            }
          }
          invalidateStats();
          return ok({ results });
        },
      );

      const fileMeta = {
        title: z.string().optional().describe('Title; defaults to the file name.'),
        description: z.string().optional().describe('What the file shows or contains (searchable).'),
        note: z.string().optional().describe('Your note about why it matters.'),
        tags: z.array(z.string()).max(5).optional(),
        collection: z.string().optional().describe('Collection name; nested with "/", e.g. "Design/Screenshots".'),
        url: z.string().optional().describe('Original link the file came from, if any.'),
        favorite: z.boolean().optional(),
      };

      server.registerTool(
        'save_file',
        {
          title: 'Save an image, video or file',
          description:
            'Save an image, video, audio file or document to Trove. Give exactly one of: data (base64 or a data: URL, files up to ~3 MB), file_url (a public direct link Notion can download) or upload (from create_upload, for big files). Returns the item and whether it already existed.',
          inputSchema: z.object({
            data: z.string().optional().describe('File contents as base64 or a data: URL.'),
            file_url: z.string().optional().describe('Public, direct URL of the file.'),
            upload: z.string().optional().describe('The upload token from create_upload, after PUTting the bytes.'),
            filename: z.string().optional().describe('File name with extension, e.g. "chart.png". Recommended with data.'),
            content_type: z.string().optional().describe('MIME type, e.g. "image/png". Guessed from the name or bytes when omitted.'),
            ...fileMeta,
          }),
        },
        async (a) => {
          try {
            const source: FileSource | null = a.upload
              ? { kind: 'upload', token: a.upload }
              : a.data
                ? { kind: 'bytes', bytes: decodeBase64(a.data), filename: a.filename, contentType: a.content_type || dataUrlType(a.data) || undefined }
                : a.file_url
                  ? { kind: 'url', url: a.file_url, filename: a.filename, contentType: a.content_type }
                  : null;
            if (!source) return fail(new Error('Pass data, file_url or upload'));
            const r = await saveFile(source, toSaveInput({ title: a.title, note: a.note, tags: a.tags, collection: a.collection, url: a.url, favorite: a.favorite, source: 'Agent' }, who), { description: a.description });
            invalidateStats();
            return ok({ created: r.created, item: brief(r.item) });
          } catch (e) {
            return fail(e);
          }
        },
      );

      server.registerTool(
        'create_upload',
        {
          title: 'Get an upload URL for a big file',
          description:
            'For files too big to send as base64 (over ~3 MB, e.g. videos). Returns put.url and put.headers: send the raw bytes there with an HTTP PUT (curl -X PUT --data-binary @file "<url>" -H "<header>: <value>" …), then call save_file with the returned upload. If sha256 matches a file already saved, returns that item instead and nothing needs uploading.',
          inputSchema: z.object({
            filename: z.string().describe('File name with extension.'),
            size: z.number().int().positive().describe('Size in bytes.'),
            content_type: z.string().optional(),
            sha256: z.string().optional().describe('Hex SHA-256 of the file, to skip uploading files saved before.'),
            ...fileMeta,
          }),
        },
        async (a) => {
          try {
            const r = await createUpload(
              { filename: a.filename, contentType: a.content_type, size: a.size, sha256: a.sha256 },
              toSaveInput({ title: a.title, note: a.note, tags: a.tags, collection: a.collection, url: a.url, favorite: a.favorite, source: 'Agent' }, who),
            );
            if ('item' in r) {
              invalidateStats();
              return ok({ duplicate: true, created: false, item: brief(r.item) });
            }
            const curl = `curl -sS -X PUT --data-binary @${JSON.stringify(a.filename)} ${JSON.stringify(r.put.url)} ${Object.entries(r.put.headers)
              .map(([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`)
              .join(' ')}`;
            return ok({ ...r, curl, then: { tool: 'save_file', arguments: { upload: r.upload, title: a.title, description: a.description, tags: a.tags, collection: a.collection, note: a.note } } });
          } catch (e) {
            return fail(e);
          }
        },
      );

      server.registerTool(
        'search',
        {
          title: 'Search Trove',
          description: 'Search or list saved items (newest first). Supports the Trove query syntax described in the server instructions.',
          inputSchema: z.object({
            query: z.string().optional().describe('e.g. "llm agents #ai type:article", or empty for latest'),
            collection: z.string().optional(),
            limit: z.number().int().min(1).max(50).optional(),
            sort: z.enum(['newest', 'oldest', 'title', 'published']).optional(),
            cursor: z.string().optional().describe('Pass the cursor from a previous result to get the next page.'),
          }),
          annotations: { readOnlyHint: true },
        },
        async ({ query, collection, limit, sort, cursor }) => {
          try {
            const r = await list({ q: query || '', query: collection ? { collection } : {}, limit: limit || 20, sort, cursor });
            return ok({ items: r.items.map(brief), cursor: r.cursor });
          } catch (e) {
            return fail(e);
          }
        },
      );

      server.registerTool(
        'get_item',
        { title: 'Read a saved item', description: 'Get one item with its archived content as Markdown (article text, post text, video transcript, highlights).', inputSchema: z.object({ id: z.string(), max_chars: z.number().int().min(500).max(100000).optional() }), annotations: { readOnlyHint: true } },
        async ({ id, max_chars }) => {
          try {
            const { item, markdown } = await getItem(id, { content: true });
            const max = max_chars || 30000;
            return ok({ item: brief(item), content: markdown && markdown.length > max ? markdown.slice(0, max) + '\n…(truncated)' : markdown });
          } catch (e) {
            return fail(e);
          }
        },
      );

      server.registerTool(
        'update_item',
        {
          title: 'Update an item',
          description: 'Change title, note, collection, tags (replace, add or remove), favorite or read state.',
          inputSchema: z.object({
            id: z.string(),
            title: z.string().optional(),
            note: z.string().optional(),
            collection: z.string().nullable().optional().describe('null moves it to Unsorted'),
            tags: z.array(z.string()).optional().describe('Replace all tags'),
            add_tags: z.array(z.string()).optional(),
            remove_tags: z.array(z.string()).optional(),
            favorite: z.boolean().optional(),
            read: z.boolean().optional(),
          }),
        },
        async (a) => {
          try {
            let tags = a.tags;
            if (!tags && (a.add_tags || a.remove_tags)) {
              const { item } = await getItem(a.id);
              tags = [...item.tags, ...(a.add_tags || [])].filter((t) => !(a.remove_tags || []).includes(t));
            }
            const item = await update(a.id, { title: a.title, note: a.note, collection: a.collection, tags, favorite: a.favorite, read: a.read });
            invalidateStats();
            return ok({ item: brief(item) });
          } catch (e) {
            return fail(e);
          }
        },
      );

      server.registerTool(
        'add_highlight',
        { title: 'Add a highlight', description: 'Store a quote (and optional comment) on a saved item.', inputSchema: z.object({ id: z.string(), text: z.string(), note: z.string().optional() }) },
        async ({ id, text, note }) => {
          try {
            return ok({ item: brief(await addHighlight(id, text, note)) });
          } catch (e) {
            return fail(e);
          }
        },
      );

      server.registerTool(
        'delete_item',
        { title: 'Delete an item', description: 'Move an item to the trash (recoverable in Notion). Only when the user explicitly asks.', inputSchema: z.object({ id: z.string() }), annotations: { destructiveHint: true } },
        async ({ id }) => {
          try {
            await remove(id);
            invalidateStats();
            return ok({ deleted: id });
          } catch (e) {
            return fail(e);
          }
        },
      );

      server.registerTool(
        'check_saved',
        { title: 'Check if links are saved', description: 'For up to 20 URLs, return the saved item or null.', inputSchema: z.object({ urls: z.array(z.string()).min(1).max(20) }), annotations: { readOnlyHint: true } },
        async ({ urls }) => {
          try {
            const r = await lookup(urls);
            return ok(Object.fromEntries(Object.entries(r).map(([u, it]) => [u, it ? brief(it) : null])));
          } catch (e) {
            return fail(e);
          }
        },
      );

      server.registerTool(
        'list_collections',
        { title: 'List collections', description: 'Collections with item counts.', inputSchema: z.object({}), annotations: { readOnlyHint: true } },
        async () => {
          try {
            return ok((await stats()).collections.map(({ name, count }) => ({ name, count })));
          } catch (e) {
            return fail(e);
          }
        },
      );

      server.registerTool(
        'list_tags',
        { title: 'List tags', description: 'Tags with item counts (most used first).', inputSchema: z.object({ limit: z.number().int().min(1).max(500).optional() }), annotations: { readOnlyHint: true } },
        async ({ limit }) => {
          try {
            return ok((await stats()).tags.slice(0, limit || 200).map(({ name, count }) => ({ name, count })));
          } catch (e) {
            return fail(e);
          }
        },
      );

      server.registerTool(
        'rename',
        { title: 'Rename or merge a tag/collection', description: 'Rename a tag or collection everywhere; renaming onto an existing name merges them. Empty "to" removes it from all items.', inputSchema: z.object({ kind: z.enum(['tag', 'collection']), from: z.string(), to: z.string() }) },
        async ({ kind, from, to }) => {
          try {
            return ok(await renameFacet(kind, from, to));
          } catch (e) {
            return fail(e);
          }
        },
      );
    },
    { serverInfo: { name: 'trove', version: '2.4.0' }, instructions: INSTRUCTIONS },
  );
}

async function handle(req: Request) {
  const who = caller(req);
  if (!who) return unauthorized();
  return build(who)(req);
}

export { handle as GET, handle as POST, handle as DELETE };
