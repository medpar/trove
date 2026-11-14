// What happens after something is saved: OCR of images and PDFs, AI filing (collection, tags,
// one-line summary), the embedding for semantic search, and the web archive (a self-contained
// snapshot in Notion plus a Wayback Machine capture). Every step is optional and best-effort:
// a failure in one never undoes the save or blocks the others.
import 'server-only';
import { AIUnavailable, MODELS, aiEnabled, complete, completeJson, embed, packVector, type Part } from './ai';
import { BROWSER_COLLECTION, GITHUB_COLLECTION, PINTEREST_COLLECTION, X_COLLECTION } from './library-schema.js';
import { env } from './env';
import { buildSnapshot, waybackSave } from './snapshot';
import { FULLTEXT_MAX, L, X_TYPE, invalidateStats, notion, rt, schemaOf, stats, toItem, type Item, type SaveInput, type SaveResult } from './store';

const SYSTEM_COLLECTIONS = [X_COLLECTION, BROWSER_COLLECTION, PINTEREST_COLLECTION, GITHUB_COLLECTION];
const isSystem = (c: string) => SYSTEM_COLLECTIONS.some((s) => c === s || c.startsWith(`${s}/`));

/** Sources that bring things in bulk: they are summarized and indexed, but never re-filed. */
export const BULK_SOURCES = new Set(['Import', 'Browser bookmarks', 'Pinterest', 'Feed', 'GitHub']);

export type EnrichOptions = {
  /** Pick a collection and tags when the item has none (default: only for fresh captures). */
  autofile?: boolean;
  /** Write the one-line summary (default true). */
  summary?: boolean;
  /** Read text in images and PDFs (default true). */
  ocr?: boolean;
  /** Snapshot the page and capture it in the Wayback Machine (default true for web pages). */
  archive?: boolean;
  /** Compute the search embedding (default true). */
  embed?: boolean;
  /** Page HTML already captured by the client (the extension sends the logged-in page). */
  html?: string;
};

export type EnrichResult = {
  item: Item;
  filed?: { collection: string | null; tags: string[] } | null;
  summary?: string;
  ocrChars?: number;
  snapshot?: boolean;
  archive?: string | null;
  skipped: string[];
  errors: string[];
};

const txt = (p: any) => (p?.rich_text || p?.title || []).map((t: any) => t.plain_text).join('');
const fileUrl = (f: any) => f?.file?.url || f?.external?.url || null;

/** Text Trove already has for a page (properties only, no block reads). */
export function pageText(page: any) {
  const pr = page.properties || {};
  const full = txt(pr[L.fulltext]);
  const text = txt(pr[L.text]);
  return full.length > text.length ? full : text;
}

// ---------- OCR ----------

const IMAGE_MAX = 9_000_000;
const PDF_MAX = 18_000_000;

async function download(url: string, max: number): Promise<{ bytes: Uint8Array; type: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len > max) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > max ? null : { bytes, type: (res.headers.get('content-type') || '').split(';')[0] };
  } catch {
    return null;
  }
}

/** What to read: uploaded images and PDFs, image links, and photos in posts. */
function ocrTargets(page: any, item: Item): { url: string; kind: 'image' | 'pdf'; name: string }[] {
  const files: any[] = page.properties?.[L.media]?.files || [];
  const out: { url: string; kind: 'image' | 'pdf'; name: string }[] = [];
  for (const f of files) {
    const url = fileUrl(f);
    const name = String(f.name || '');
    if (!url) continue;
    if (/\.pdf(\?|$)/i.test(url) || /\.pdf$/i.test(name) || (item.type === 'Document' && /pdf/i.test(name + url))) out.push({ url, kind: 'pdf', name: name || 'document.pdf' });
    else if (/^(photo|image)/i.test(name) || /\.(jpe?g|png|webp|gif|heic|avif)(\?|$)/i.test(url) || item.type === 'Image') out.push({ url, kind: 'image', name: name || 'image' });
  }
  if (!out.length && item.type === 'Image' && item.cover) out.push({ url: item.cover, kind: 'image', name: 'cover' });
  return out.filter((t) => !/\.(mp4|mov|webm|m4v)(\?|$)/i.test(t.url)).slice(0, item.type === X_TYPE || item.type === 'Post' ? 2 : 4);
}

const OCR_IMAGE = `Read this image for a personal search index.
First transcribe every piece of meaningful text exactly as written (keep the language, line breaks and reading order; skip UI chrome like status bars). If there is no meaningful text, write NONE.
Then add a last line that starts with "DESCRIPTION:" and describes the image in one plain sentence (what it shows, notable objects, people, places, style).`;

const OCR_PDF = `Extract the full text of this document as clean Markdown (headings, lists, tables as Markdown tables). Keep the original language. Do not summarize or comment; output only the document text.`;

async function readTarget(t: { url: string; kind: 'image' | 'pdf'; name: string }): Promise<{ text: string; description: string } | null> {
  const file = await download(t.url, t.kind === 'pdf' ? PDF_MAX : IMAGE_MAX);
  if (!file) return null;
  const b64 = Buffer.from(file.bytes).toString('base64');
  if (t.kind === 'pdf') {
    const parts: Part[] = [{ type: 'file', file: { filename: t.name.endsWith('.pdf') ? t.name : `${t.name}.pdf`, file_data: `data:application/pdf;base64,${b64}` } }];
    const text = await complete({ model: MODELS.vision, prompt: OCR_PDF, parts, maxTokens: 16000, timeoutMs: 180000 });
    return { text: text.trim(), description: '' };
  }
  const type = file.type.startsWith('image/') ? file.type : 'image/jpeg';
  const out = await complete({ model: MODELS.vision, prompt: OCR_IMAGE, parts: [{ type: 'image_url', image_url: { url: `data:${type};base64,${b64}` } }], maxTokens: 4000, timeoutMs: 90000 });
  const m = /\n?DESCRIPTION:\s*([\s\S]*)$/i.exec(out);
  const description = m ? m[1].trim() : '';
  const text = (m ? out.slice(0, m.index) : out).trim();
  return { text: /^NONE\.?$/i.test(text) ? '' : text, description };
}

// ---------- filing ----------

type Filing = { collection?: string | null; tags?: string[]; summary?: string };

async function fileWithAI(item: Item, text: string, want: { place: boolean; summary: boolean }): Promise<Filing> {
  const s = await stats();
  const collections = s.collections.filter((c) => !isSystem(c.name)).map((c) => `${c.name} (${c.count})`);
  const tags = s.tags.slice(0, 250).map((t) => t.name);
  const system = `You organize a personal library ("Trove") of saved links, posts, videos, notes and files.
${want.place ? `Choose where this item belongs:
- "collection": the single best collection from the list below. Prefer an existing one, including a nested one like "Parent/Child". Only if nothing fits even loosely, propose a short new one, nested under an existing parent when sensible. Never use ${SYSTEM_COLLECTIONS.join(', ')}. Use null when it is a throwaway with no clear topic.
- "tags": 1 to 4 short lowercase tags. Reuse existing tags exactly when they fit; add a new tag only when it adds real meaning.` : ''}
${want.summary ? `- "summary": one sentence (max 200 characters) that says what this is and why it is useful, concrete and specific. No "This article/video..." openers.` : ''}
Write everything in English, even when the content is in another language.

Existing collections: ${collections.join('; ') || '(none yet)'}
Existing tags: ${tags.join(', ') || '(none yet)'}`;
  const prompt = [
    `Title: ${item.title}`,
    item.url ? `URL: ${item.url}` : '',
    `Type: ${item.type}${item.platform && item.platform !== 'Web' ? ` (${item.platform})` : ''}`,
    item.author ? `Author: ${item.author}` : '',
    item.note ? `User note: ${item.note}` : '',
    item.collection ? `Current collection: ${item.collection}` : '',
    item.tags.length ? `Current tags: ${item.tags.join(', ')}` : '',
    `Content:\n${(text || item.excerpt || '').slice(0, 5000)}`,
  ]
    .filter(Boolean)
    .join('\n');
  const keys = [want.place ? '"collection", "tags"' : '', want.summary ? '"summary"' : ''].filter(Boolean).join(', ');
  const r = await completeJson<Filing>({ system: `${system}\nAnswer with JSON keys: ${keys}.`, prompt, maxTokens: 400 });
  const clean: Filing = {};
  if (want.place) {
    const c = typeof r.collection === 'string' ? r.collection.trim().replace(/^\/+|\/+$/g, '').slice(0, 90) : null;
    clean.collection = c && !isSystem(c) ? (s.collections.find((x) => x.name.toLowerCase() === c.toLowerCase())?.name ?? c) : null;
    const known = new Map(s.tags.map((t) => [t.name.toLowerCase(), t.name]));
    clean.tags = (Array.isArray(r.tags) ? r.tags : typeof r.tags === 'string' ? (r.tags as string).split(/[,;]+/) : [])
      .map((t) => String(t).trim().replace(/^#/, '').replace(/,/g, ' ').slice(0, 40))
      .filter(Boolean)
      .map((t) => known.get(t.toLowerCase()) || t.toLowerCase())
      .slice(0, 4);
  }
  if (want.summary && typeof r.summary === 'string') clean.summary = r.summary.trim().slice(0, 300);
  return clean;
}

/** Text that represents an item for semantic search. */
export function embedText(item: Pick<Item, 'title' | 'summary' | 'excerpt' | 'tags' | 'collection' | 'note' | 'domain' | 'author' | 'type'>, text = '') {
  return [item.title, item.summary, item.excerpt, item.note, item.tags.length ? `Tags: ${item.tags.join(', ')}` : '', item.collection ? `Collection: ${item.collection}` : '', item.author, item.domain, item.type, text.slice(0, 6000)]
    .filter(Boolean)
    .join('\n');
}

// ---------- the pipeline ----------

const ARCHIVE_TYPES = new Set(['Article', 'Link', 'Product', 'Paper', 'Repo', 'Post', 'Document', 'Note']);

export async function enrich(id: string, o: EnrichOptions = {}): Promise<EnrichResult> {
  await schemaOf();
  const page = await notion().req('GET', `/pages/${id}`);
  let item = toItem(page);
  const res: EnrichResult = { item, skipped: [], errors: [] };
  const props: Record<string, unknown> = {};
  const blocks: any[] = [];
  const ai = aiEnabled();
  const note = (e: unknown, step: string) => {
    if (e instanceof AIUnavailable) res.skipped.push(`${step}: ${e.message}`);
    else res.errors.push(`${step}: ${(e as Error)?.message || e}`);
  };

  // Web archive runs alongside the AI steps.
  const isWeb = !!item.url && item.type !== X_TYPE && item.platform !== 'Upload' && /^https?:/.test(item.url);
  const archiveJob = (async () => {
    if (o.archive === false || !isWeb) return;
    const [snap, wb] = await Promise.all([
      !item.snapshot && ARCHIVE_TYPES.has(item.type) && item.platform !== 'YouTube'
        ? buildSnapshot(item.url, o.html).catch((e) => (note(e, 'snapshot'), null))
        : Promise.resolve(null),
      !item.archive ? waybackSave(item.url).catch(() => null) : Promise.resolve(null),
    ]);
    if (snap && snap.length > 2000) {
      try {
        const uploadId = await notion().uploadBytes(snap, 'snapshot.html', 'text/html');
        props[L.snapshot] = { files: [{ type: 'file_upload', file_upload: { id: uploadId }, name: 'snapshot.html' }] };
        res.snapshot = true;
      } catch (e) {
        note(e, 'snapshot upload');
      }
    }
    if (wb) {
      props[L.archive] = { url: wb };
      res.archive = wb;
    }
  })();

  let text = pageText(page);

  // 1. OCR
  if (ai && o.ocr !== false) {
    const targets = ocrTargets(page, item);
    if (targets.length && !/^\s*$/.test(targets[0].url)) {
      try {
        const reads = (await Promise.all(targets.map((t) => readTarget(t).catch((e) => (note(e, 'ocr'), null))))).filter(Boolean) as { text: string; description: string }[];
        const ocr = reads.map((r) => r.text).filter(Boolean).join('\n\n');
        const description = reads.map((r) => r.description).filter(Boolean).join(' ');
        if (ocr || description) {
          text = [text, ocr, description].filter(Boolean).join('\n\n');
          props[L.fulltext] = { rich_text: rt(text.slice(0, FULLTEXT_MAX)) };
          props[L.text] = { rich_text: rt(text.slice(0, 12000)) };
          if (!item.excerpt && description) props[L.description] = { rich_text: rt(description.slice(0, 1900)) };
          res.ocrChars = ocr.length;
          if (ocr) {
            blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: rt(targets[0].kind === 'pdf' ? 'Document text' : 'Text in image') } });
            for (const p of ocr.split(/\n{2,}/).filter((x) => x.trim()).slice(0, 90)) blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(p.slice(0, 1900)) } });
          }
        }
      } catch (e) {
        note(e, 'ocr');
      }
    }
  }

  // 2. Filing and summary
  const place = !!o.autofile && !item.collection;
  const wantSummary = o.summary !== false && !item.summary && (text.length > 200 || (item.excerpt?.length || 0) > 80 || item.type === 'Image');
  if (ai && (place || wantSummary)) {
    try {
      const f = await fileWithAI(item, text, { place, summary: wantSummary });
      if (place) {
        const tags = item.tags.length ? item.tags : f.tags || [];
        if (f.collection) props[L.collection] = { select: { name: f.collection } };
        if (!item.tags.length && tags.length) props[L.tags] = { multi_select: tags.map((name) => ({ name })) };
        res.filed = { collection: f.collection || null, tags: item.tags.length ? [] : tags };
        item = { ...item, collection: f.collection || item.collection, tags };
      }
      if (f.summary) {
        props[L.summary] = { rich_text: rt(f.summary) };
        res.summary = f.summary;
        item = { ...item, summary: f.summary };
      }
    } catch (e) {
      note(e, 'filing');
    }
  }

  // 3. Embedding
  if (ai && o.embed !== false) {
    try {
      const [v] = await embed([embedText(item, text)]);
      props[L.embedding] = { rich_text: rt(packVector(v)) };
    } catch (e) {
      note(e, 'embedding');
    }
  }

  await archiveJob;
  // Only mark it done when the AI steps ran, so items saved while AI was unavailable get another pass.
  if (!res.skipped.length) props[L.enriched] = { date: { start: new Date().toISOString() } };
  if (!Object.keys(props).length) return res;
  const updated = await notion().updatePage(id, { properties: props });
  if (blocks.length) await notion().appendChildren(id, blocks.slice(0, 100)).catch((e: unknown) => note(e, 'ocr blocks'));
  invalidateStats();
  res.item = toItem(updated);
  return res;
}

/** Enrich items that were never processed (X sync, Pinterest, imports, older saves), newest first. */
export async function enrichPending({ limit = 20, deadline = Date.now() + 240000, archive = true } = {}) {
  await schemaOf();
  const q = await notion().query(env().libraryDs, {
    filter: { property: L.enriched, date: { is_empty: true } },
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    page_size: Math.min(limit, 100),
  });
  let done = 0;
  const errors: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < q.results.length && Date.now() < deadline) {
        const page = q.results[next++];
        try {
          const r = await enrich(page.id, { autofile: false, archive });
          done++;
          if (r.skipped.length && r.skipped.every((s) => /AI/i.test(s))) errors.push(...r.skipped.slice(0, 1));
        } catch (e: any) {
          errors.push(`${page.id}: ${e?.message || e}`);
        }
      }
    }),
  );
  return { done, remaining: q.has_more || next < q.results.length, errors: [...new Set(errors)].slice(0, 5) };
}

/** Should a fresh save be filed by AI? Only captures without a collection, never bulk imports. */
export function shouldAutofile(input: SaveInput) {
  return input.autofile !== false && !input.collection && !BULK_SOURCES.has(input.source || '');
}

/**
 * Run after a save (from a route's after() or awaited by the Telegram bot). Bulk sources are
 * left to the daily backfill so a big import doesn't fan out hundreds of AI calls at once.
 */
export async function afterSave(r: SaveResult, input: SaveInput): Promise<EnrichResult | null> {
  if (!r.created || BULK_SOURCES.has(input.source || '') || input.archive === false) return null;
  return enrich(r.item.id, { autofile: shouldAutofile(input), html: input.meta?.html });
}
