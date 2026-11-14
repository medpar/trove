// Semantic search over the library. Each item's embedding lives in Notion (the "Embedding"
// column, int8, written by enrich()); this module keeps an in-memory index of them, backed by
// a compact cache in Blob so cold starts don't read the whole database, and refreshed with the
// pages edited since the cache was written.
import 'server-only';
import { AIUnavailable, complete, dot, embed, unpackVector } from './ai';
import { env } from './env';
import { L, list, notion, schemaOf, toItem, type Item } from './store';
import { readState, writeState } from './state';

type Entry = { v: Int8Array; item: Item };
type Index = { at: number; entries: Map<string, Entry>; checked: number };
type Stored = { v: 1; at: number; entries: { id: string; v: string; item: Item }[] };

let index: Index | null = null;
let loading: Promise<Index> | null = null;
const FRESH_MS = 60_000;

const txt = (p: any) => (p?.rich_text || []).map((t: any) => t.plain_text).join('');

/** Every property toItem() reads, plus the embedding; not the full text. */
async function indexProps() {
  const props = await schemaOf();
  return Object.entries(props)
    .filter(([name]) => name !== L.fulltext && name !== L.text)
    .map(([, p]: [string, any]) => p.id)
    .filter(Boolean) as string[];
}

async function pullSince(since: number | null, into: Map<string, Entry>) {
  const filter: any[] = [{ property: L.embedding, rich_text: { is_not_empty: true } }];
  if (since) filter.push({ timestamp: 'last_edited_time', last_edited_time: { on_or_after: new Date(since - 120_000).toISOString() } });
  let n = 0;
  for await (const page of notion().queryAll(env().libraryDs, { filter: filter.length > 1 ? { and: filter } : filter[0] }, await indexProps())) {
    const v = unpackVector(txt(page.properties?.[L.embedding]));
    if (!v) continue;
    const item = toItem(page);
    item.excerpt = item.excerpt.slice(0, 240);
    into.set(page.id, { v, item });
    n++;
  }
  return n;
}

async function load(): Promise<Index> {
  const now = Date.now();
  if (index && now - index.checked < FRESH_MS) return index;
  if (loading) return loading;
  loading = (async () => {
    let idx = index;
    if (!idx) {
      const stored = await readState<Stored>('vectors.json');
      const entries = new Map<string, Entry>();
      for (const e of stored?.entries || []) {
        const v = unpackVector(e.v);
        if (v) entries.set(e.id, { v, item: e.item });
      }
      idx = { at: stored?.at || 0, entries, checked: 0 };
    }
    const started = Date.now();
    const changed = await pullSince(idx.at || null, idx.entries);
    idx.checked = Date.now();
    // Persist when the cache is new or noticeably behind, so the next cold start is quick.
    if (!idx.at || changed > 25) {
      idx.at = started;
      save(idx).catch(() => {});
    }
    index = idx;
    return idx;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

async function save(idx: Index) {
  const entries = [...idx.entries].map(([id, e]) => ({ id, v: `v1:${Buffer.from(e.v.buffer, e.v.byteOffset, e.v.length).toString('base64')}`, item: e.item }));
  await writeState('vectors.json', { v: 1, at: idx.at, entries } satisfies Stored);
}

/** Rebuild the index from scratch (drops deleted items). Called by the daily cron. */
export async function rebuildIndex() {
  const entries = new Map<string, Entry>();
  const at = Date.now();
  await pullSince(null, entries);
  index = { at, entries, checked: Date.now() };
  await save(index).catch(() => {});
  return { items: entries.size };
}

export function forget(id: string) {
  if (!index) return;
  for (const key of [...index.entries.keys()]) if (key.replace(/-/g, '') === id.replace(/-/g, '')) index.entries.delete(key);
}

export type Hit = Item & { score: number };

/** Items closest in meaning to the query. */
export async function semanticSearch(q: string, k = 30): Promise<Hit[]> {
  const [qv, idx] = await Promise.all([embed([q]).then((r) => r[0]), load()]);
  const scored: Hit[] = [];
  for (const e of idx.entries.values()) scored.push({ ...e.item, score: dot(qv, e.v) / (127 * 4) });
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

/** Items similar to one item. */
export async function related(id: string, k = 8): Promise<Hit[]> {
  const idx = await load();
  let me = idx.entries.get(id) || [...idx.entries.entries()].find(([key]) => key.replace(/-/g, '') === id.replace(/-/g, ''))?.[1];
  if (!me) {
    const page = await notion().req('GET', `/pages/${id}`);
    const v = unpackVector(txt(page.properties?.[L.embedding]));
    if (!v) return [];
    me = { v, item: toItem(page) };
  }
  const norm = Math.sqrt(dot(me.v, me.v)) || 1;
  const out: Hit[] = [];
  for (const [key, e] of idx.entries) {
    if (key === id || e.item.id === me.item.id) continue;
    out.push({ ...e.item, score: dot(me.v, e.v) / (norm * (Math.sqrt(dot(e.v, e.v)) || 1)) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}

const hasOperators = (q: string) => /(^|\s)(-?#|-\w|\w+:|")/.test(q);

/**
 * Hybrid search: keyword matches (Notion) and meaning matches (embeddings) merged with
 * reciprocal rank fusion. Queries with operators (#tag, type:, site:...) stay keyword-only.
 * Falls back to keyword search when AI is unavailable.
 */
export async function hybridSearch(q: string, k = 40, { loose = false } = {}): Promise<{ items: Item[]; mode: 'hybrid' | 'keyword'; note?: string }> {
  const keywordJob = list({ q, limit: Math.min(k, 40) }).then((r) => r.items);
  if (!q.trim() || hasOperators(q)) return { items: await keywordJob, mode: 'keyword' };
  let semantic: Hit[] = [];
  let note: string | undefined;
  try {
    semantic = await semanticSearch(q, k);
  } catch (e) {
    note = e instanceof AIUnavailable ? `Smart search is off: ${e.message}` : `Smart search failed: ${(e as Error).message}`;
  }
  let keyword = await keywordJob.catch(() => [] as Item[]);
  if (!semantic.length && keyword.length < 5) keyword = mergeUnique(keyword, await looseKeyword(q, k));
  if (!semantic.length) return { items: keyword, mode: 'keyword', note };
  const score = new Map<string, { item: Item; s: number }>();
  const add = (items: Item[], weight: number) =>
    items.forEach((it, rank) => {
      const cur = score.get(it.id) || { item: it, s: 0 };
      cur.s += weight / (60 + rank);
      score.set(it.id, cur);
    });
  add(keyword, 1.1);
  // Weak semantic matches only count when nothing better exists.
  const best = semantic[0]?.score || 0;
  add(loose ? semantic : semantic.filter((h) => h.score > Math.max(0.2, best * 0.6)), 1);
  return { items: [...score.values()].sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.item), mode: 'hybrid' };
}

const STOP = new Set(
  'a an and are as at be by can do does for from has have how i in is it me my of on or so that the this to was what when where which who why with you your about into over than then them they we our el la los las un una unos unas y o de del al en con por para que qué como cómo cuál cuando dónde es son se lo le les mi mis tu su sus sobre más muy ya hay'.split(' '),
);

function mergeUnique(a: Item[], b: Item[]) {
  const seen = new Set(a.map((i) => i.id));
  return [...a, ...b.filter((i) => !seen.has(i.id))];
}

/** Without embeddings: match any meaningful word, then rank by how many words each item contains. */
async function looseKeyword(q: string, k: number): Promise<Item[]> {
  // Crude stemming so "enterprises" finds "Enterprise" and "selling" finds "sell".
  const stem = (w: string) => (w.length > 5 && /ies$/.test(w) ? w.slice(0, -3) : w.length > 5 && /ing$/.test(w) ? w.slice(0, -3) : w.length > 4 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
  const words = [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 2 && !STOP.has(w)).map(stem))].slice(0, 8);
  if (!words.length) return [];
  const r = await list({ q: `${words.join(' ')} match:OR`, limit: 100 }).catch(() => ({ items: [] as Item[] }));
  const score = (it: Item) => {
    const hay = `${it.title} ${it.summary} ${it.excerpt} ${it.tags.join(' ')} ${it.collection || ''}`.toLowerCase();
    return words.reduce((n, w) => n + (hay.includes(w) ? (it.title.toLowerCase().includes(w) ? 2 : 1) : 0), 0);
  };
  return r.items
    .map((it) => ({ it, s: score(it) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.it);
}

// ---------- ask ----------

export type Answer = { answer: string; sources: Item[] };

/** Answer a question from the library, citing the items it used as [1], [2]... */
export async function ask(question: string, k = 8): Promise<Answer> {
  // Questions are full sentences: keep the closest items even when no single word matches.
  const { items } = await hybridSearch(question, 24, { loose: true });
  const top = items.slice(0, k);
  if (!top.length) return { answer: "I couldn't find anything in your library about that.", sources: [] };
  const pages = await Promise.all(top.map((it) => notion().req('GET', `/pages/${it.id}`).catch(() => null)));
  const context = top
    .map((it, i) => {
      const pr = pages[i]?.properties || {};
      const body = txt(pr[L.text]).slice(0, 3500);
      return `[${i + 1}] ${it.title}\nURL: ${it.url || '(note)'}\nSaved: ${it.created.slice(0, 10)}${it.collection ? ` · Collection: ${it.collection}` : ''}${it.tags.length ? ` · Tags: ${it.tags.join(', ')}` : ''}\n${it.summary ? `Summary: ${it.summary}\n` : ''}${it.note ? `User note: ${it.note}\n` : ''}${body}`;
    })
    .join('\n\n---\n\n');
  const answer = await complete({
    system: `You answer questions using only the user's saved library items below. Cite items inline as [1], [2] matching their numbers. If the items don't answer the question, say so briefly and point to the closest ones. Be concise: a short paragraph or a few bullets. Answer in the language of the question.`,
    prompt: `Library items:\n\n${context}\n\nQuestion: ${question}`,
    maxTokens: 900,
  });
  return { answer: answer.trim(), sources: top };
}
