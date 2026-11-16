// Episodes: what you watch and listen to on YouTube and Spotify, one Notion page per episode with
// both platforms on it, in an "Episodes" database next to Trove (created on first use). Each page
// keeps the full progress record (played ranges per platform, positions, what Spotify and YouTube
// report for your account) as JSON in its Data column, and readable columns for Notion views.
// Edits made in Notion (title, show, series, status, ids) are picked up.
import 'server-only';
import { applyEvent, clock, markManual, mergePlatform, mergeRecords, PLATFORM_NAME, settle, summarize, youtubeId, spotifyEpisodeId, watchUrl } from '../../extension/lib/progress.js';
import { env } from './env';
import { readState, writeState } from './state';
import { notion, rt } from './store';

export type P = 'yt' | 'sp';
export type Ext = { pos?: number; dur?: number | null; done?: boolean; doneAt?: number | null; at?: number; src?: string; seen?: boolean };
export type Copy = { id: string; title?: string; show?: string; showId?: string; channel?: string; channelId?: string; image?: string; released?: string; dur?: number; ranges?: number[][]; pos?: number; at?: number; ext?: Ext };
export type Rec = {
  v?: number;
  title?: string;
  show?: string;
  series?: string | null;
  seriesBy?: 'manual' | 'auto' | null;
  image?: string;
  released?: string;
  yt?: Copy;
  sp?: Copy;
  manual?: { done: boolean; at: number };
  finishedAt?: number;
  linked?: { by: string; score?: number; at?: number };
  unlinked?: string[];
};
export type EpisodeEvent = {
  p: P;
  id: string;
  at?: number;
  title?: string;
  show?: string;
  showId?: string;
  channel?: string;
  channelId?: string;
  image?: string;
  released?: string;
  dur?: number;
  ranges?: number[][];
  pos?: number;
  ext?: { pos?: number; done?: boolean; dur?: number; seen?: boolean };
  src?: string;
  /** When the player that sends these ranges started (they are everything it played since). */
  since?: number;
  /** Server sync bookkeeping: what to remember as seen once this event is stored. */
  mark?: { side: 'spotify' | 'youtube'; id: string; sig: string | number };
  /** The same episode on the other platform, when the sender knows it (catalog match, manual link). */
  /** The same episode on the other platform; its length and title when known (to map positions across). */
  twin?: { p: P; id: string; by?: string; score?: number; dur?: number; title?: string } | null;
  /** Show this episode belongs to in Trove (followed shows), and its series. */
  troveShow?: string;
  series?: string | null;
};

export type Card = {
  id: string;
  title: string;
  show: string | null;
  series: string | null;
  image: string | null;
  released: string | null;
  yt: { id: string; dur: number | null; title: string | null } | null;
  sp: { id: string; dur: number | null; title: string | null } | null;
  status: 'new' | 'started' | 'finished';
  pct: number;
  finishedAt: number | null;
  doneOn: string | null;
  resume: { p: P; pos: number; dur: number | null; at: number; src: string } | null;
  last: { p: P; at: number } | null;
  /** Seen on this platform with no position (YouTube's history keeps none for some videos). */
  seen: P | null;
  updated: string;
  notionUrl: string;
};

// ---------- schema ----------

export const E = {
  title: 'Title', show: 'Show', series: 'Series', status: 'Status', progress: 'Progress', resume: 'Resume at', youtube: 'YouTube', spotify: 'Spotify',
  ytId: 'YouTube ID', spId: 'Spotify ID', minutes: 'Minutes', last: 'Last played', finished: 'Finished', platform: 'Last platform', released: 'Released', data: 'Data',
};

const STATUS_NAME = { new: 'New', started: 'In progress', finished: 'Finished' } as const;

export function episodesSchema() {
  const sel = (options: [string, string][] = []) => ({ select: { options: options.map(([name, color]) => ({ name, color })) } });
  return {
    [E.title]: { title: {} },
    [E.show]: sel(),
    [E.series]: sel(),
    [E.status]: sel([['New', 'gray'], ['In progress', 'yellow'], ['Finished', 'green']]),
    [E.progress]: { number: { format: 'percent' } },
    [E.resume]: { rich_text: {} },
    [E.youtube]: { url: {} },
    [E.spotify]: { url: {} },
    [E.ytId]: { rich_text: {} },
    [E.spId]: { rich_text: {} },
    [E.minutes]: { number: { format: 'number' } },
    [E.last]: { date: {} },
    [E.finished]: { date: {} },
    [E.platform]: sel([['YouTube', 'red'], ['Spotify', 'green']]),
    [E.released]: { date: {} },
    [E.data]: { rich_text: {} },
  } as Record<string, any>;
}

type DbRef = { dataSourceId: string; databaseId: string; url?: string };
let dbRef: Promise<DbRef> | null = null;

async function ensureSchema(dataSourceId: string) {
  const ds = await notion().getDataSource(dataSourceId);
  const have = ds.properties || {};
  const patch: Record<string, any> = {};
  for (const [name, def] of Object.entries(episodesSchema())) if (name !== E.title && !have[name]) patch[name] = def;
  const titleName = Object.entries(have).find(([, v]: any) => v.type === 'title')?.[0];
  if (titleName && titleName !== E.title && !have[E.title]) patch[titleName] = { name: E.title };
  if (Object.keys(patch).length) await notion().updateDataSource(dataSourceId, { properties: patch });
}

/** The Episodes data source: TROVE_EPISODES_DS, or the one Trove created, or a new one next to the Trove database. */
export function episodesDb(): Promise<DbRef> {
  dbRef ||= (async () => {
    const fromEnv = process.env.TROVE_EPISODES_DS?.trim();
    if (fromEnv) {
      await ensureSchema(fromEnv);
      return { dataSourceId: fromEnv, databaseId: process.env.TROVE_EPISODES_DB?.trim() || '' };
    }
    const saved = await readState<DbRef>('episodes.json');
    if (saved?.dataSourceId) {
      await ensureSchema(saved.dataSourceId);
      return saved;
    }
    const n = notion();
    const libDbId = env().libraryDb || (await n.getDataSource(env().libraryDs)).parent?.database_id;
    const lib = libDbId ? await n.getDatabase(libDbId) : null;
    const parent = lib?.parent?.type === 'page_id' ? { type: 'page_id', page_id: lib.parent.page_id } : { type: 'workspace', workspace: true };
    const db = await n.req('POST', '/databases', {
      parent,
      title: [{ type: 'text', text: { content: 'Episodes' } }],
      icon: { type: 'emoji', emoji: '🎧' },
      description: [{ type: 'text', text: { content: 'What you watch and listen to on YouTube and Spotify, tracked by Trove: one page per episode with where you are on each platform.' } }],
      initial_data_source: { properties: episodesSchema() },
    });
    const ref: DbRef = { dataSourceId: db.data_sources?.[0]?.id, databaseId: db.id, url: db.url };
    if (!ref.dataSourceId) throw new Error('Notion did not return the new Episodes data source');
    // Another server instance may have created one at the same moment: keep the first one saved.
    const raced = await readState<DbRef>('episodes.json');
    if (raced?.dataSourceId) {
      await n.req('PATCH', `/databases/${db.id}`, { in_trash: true }).catch(() => {});
      return raced;
    }
    await writeState('episodes.json', ref);
    await createViews(ref).catch(() => {});
    return ref;
  })().catch((e) => {
    dbRef = null;
    throw e;
  });
  return dbRef;
}

async function createViews({ databaseId, dataSourceId }: DbRef) {
  const views = [
    { name: 'In progress', type: 'table', filter: { property: E.status, select: { equals: 'In progress' } }, sorts: [{ property: E.last, direction: 'descending' }] },
    { name: 'Finished', type: 'table', filter: { property: E.status, select: { equals: 'Finished' } }, sorts: [{ property: E.finished, direction: 'descending' }] },
    { name: 'By show', type: 'board', configuration: { type: 'board', group_by: { type: 'select', property_id: E.show } }, sorts: [{ property: E.released, direction: 'descending' }] },
  ];
  for (const v of views) {
    try {
      await notion().req('POST', '/views', { database_id: databaseId, data_source_id: dataSourceId, ...v });
    } catch { /* views are optional */ }
  }
}

// ---------- page <-> record ----------

const txt = (p: any) => (p?.rich_text || p?.title || []).map((t: any) => t.plain_text).join('');
const selName = (s: string) => s.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
const iso = (ms: number) => new Date(ms).toISOString();

/** The record on a page, with edits made by hand in Notion applied. */
export function recordOf(page: any): Rec {
  const pr = page.properties || {};
  let rec: Rec = {};
  try {
    const raw = txt(pr[E.data]);
    rec = raw ? JSON.parse(raw) : {};
  } catch { /* corrupted by hand: rebuild from the columns */ }
  const title = txt(pr[E.title]).trim();
  if (title && title !== rec.title) rec.title = title;
  const show = pr[E.show]?.select?.name;
  if (show && show !== selName(rec.show || '')) rec.show = show;
  const series = pr[E.series]?.select?.name || null;
  if ((series || null) !== (rec.series ? selName(rec.series) : null)) {
    rec.series = series;
    rec.seriesBy = 'manual';
  }
  for (const [p, idProp, urlProp, parse, valid] of [['yt', E.ytId, E.youtube, youtubeId, /^[\w-]{11}$/], ['sp', E.spId, E.spotify, spotifyEpisodeId, /^[A-Za-z0-9]{22}$/]] as const) {
    const typed = (txt(pr[idProp]).trim() || parse(pr[urlProp]?.url || '') || '').trim();
    const cur = rec[p]?.id || '';
    // An id or link typed in Notion links that copy (a different one replaces it).
    if (typed && typed !== cur && valid.test(typed)) rec[p] = { id: typed };
    // Both cleared by hand: forget that copy.
    if (!typed && cur && pr[idProp] && pr[urlProp] && !pr[urlProp].url) delete rec[p];
  }
  const status = pr[E.status]?.select?.name;
  const at = Date.parse(page.last_edited_time) || Date.now();
  const s = summarize(rec);
  if (status === 'Finished' && !s.finished) rec = markManual(rec, true, at);
  if (status === 'New' && s.finished) rec = markManual(rec, false, at);
  return rec;
}

function propsOf(rec: Rec) {
  const s = summarize(rec);
  const dur = rec.sp?.dur || rec.yt?.dur || rec.sp?.ext?.dur || rec.yt?.ext?.dur || null;
  const where = (p: P | null | undefined) => (p ? PLATFORM_NAME[p] : '');
  const resume = s.finished
    ? s.doneOn === 'manual' ? 'Marked as finished' : `Finished${s.doneOn && s.doneOn !== 'both' ? ` on ${where(s.doneOn as P)}` : ''}`
    : s.resume ? `${clock(s.resume.pos)}${s.resume.dur ? ` of ${clock(s.resume.dur)}` : ''} on ${where(s.resume.p as P)}` : '';
  return {
    [E.title]: { title: rt((rec.title || rec.sp?.title || rec.yt?.title || 'Untitled').slice(0, 300)) },
    [E.show]: { select: rec.show ? { name: selName(rec.show) } : null },
    [E.series]: { select: rec.series ? { name: selName(rec.series) } : null },
    [E.status]: { select: { name: STATUS_NAME[s.status as keyof typeof STATUS_NAME] } },
    [E.progress]: { number: s.pct },
    [E.resume]: { rich_text: rt(resume) },
    [E.youtube]: { url: rec.yt?.id ? watchUrl('yt', rec.yt.id, 0) : null },
    [E.spotify]: { url: rec.sp?.id ? watchUrl('sp', rec.sp.id, 0) : null },
    [E.ytId]: { rich_text: rt(rec.yt?.id || '') },
    [E.spId]: { rich_text: rt(rec.sp?.id || '') },
    [E.minutes]: { number: dur ? Math.round(dur / 60) : null },
    [E.last]: { date: s.last ? { start: iso(s.last.at) } : null },
    [E.finished]: { date: s.finishedAt ? { start: iso(s.finishedAt) } : null },
    [E.platform]: { select: s.last ? { name: PLATFORM_NAME[s.last.p as P] } : null },
    [E.released]: { date: rec.released ? { start: rec.released.slice(0, 10) } : null },
    [E.data]: { rich_text: rt(JSON.stringify(rec)) },
  };
}

export function toCard(page: any, rec = recordOf(page)): Card {
  const s = summarize(rec);
  const copy = (c?: Copy) => (c?.id ? { id: c.id, dur: c.dur || c.ext?.dur || null, title: c.title || null } : null);
  return {
    id: page.id,
    title: rec.title || rec.sp?.title || rec.yt?.title || 'Untitled',
    show: rec.show || null,
    series: rec.series || null,
    image: rec.image || (rec.yt?.id ? `https://i.ytimg.com/vi/${rec.yt.id}/mqdefault.jpg` : null),
    released: rec.released || null,
    yt: copy(rec.yt),
    sp: copy(rec.sp),
    status: s.status as Card['status'],
    pct: s.pct,
    finishedAt: s.finishedAt,
    doneOn: s.doneOn,
    resume: s.resume as Card['resume'],
    last: s.last as Card['last'],
    seen: (s.seen as P | null) || null,
    updated: page.last_edited_time,
    notionUrl: page.url,
  };
}

// ---------- reading ----------

const refFilter = (p: P, id: string) => ({ property: p === 'yt' ? E.ytId : E.spId, rich_text: { equals: id } });

/** Pages holding any of these platform ids (normally one). */
async function pagesFor(refs: { p: P; id: string }[]) {
  const uniq = [...new Map(refs.filter((r) => r?.id).map((r) => [`${r.p}:${r.id}`, r])).values()];
  if (!uniq.length) return [];
  const { dataSourceId } = await episodesDb();
  const filter = uniq.length === 1 ? refFilter(uniq[0].p, uniq[0].id) : { or: uniq.map((r) => refFilter(r.p, r.id)) };
  const out: any[] = [];
  let cursor: string | null = null;
  do {
    const res: any = await notion().query(dataSourceId, { filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return out;
}

export async function getEpisode(pageId: string) {
  const page = await notion().req('GET', `/pages/${pageId}`);
  return { page, rec: recordOf(page) };
}

/** Cards for platform refs ("yt:<id>" / "sp:<id>"). */
export async function lookupRefs(refs: string[]): Promise<Record<string, Card | null>> {
  const parsed = refs.map((r) => /^(yt|sp):([\w-]{11,22})$/.exec(r)).filter(Boolean).map((m) => ({ p: m![1] as P, id: m![2] }));
  const out: Record<string, Card | null> = Object.fromEntries(refs.map((r) => [r, null]));
  for (let i = 0; i < parsed.length; i += 25) {
    const pages = await pagesFor(parsed.slice(i, i + 25));
    for (const page of pages) {
      const card = toCard(page);
      if (card.yt && `yt:${card.yt.id}` in out) out[`yt:${card.yt.id}`] = card;
      if (card.sp && `sp:${card.sp.id}` in out) out[`sp:${card.sp.id}`] = card;
    }
  }
  return out;
}

export type ListOptions = { status?: 'started' | 'finished' | 'new'; show?: string; since?: string | null; cursor?: string | null; limit?: number; sort?: 'last' | 'edited' | 'released' };

/** Episodes, newest activity first (or by last edit, oldest first, for incremental sync). */
export async function listEpisodes(o: ListOptions = {}): Promise<{ cards: Card[]; cursor: string | null }> {
  const { dataSourceId } = await episodesDb();
  const and: any[] = [];
  if (o.status) and.push({ property: E.status, select: { equals: STATUS_NAME[o.status] } });
  if (o.show) and.push({ property: E.show, select: { equals: selName(o.show) } });
  if (o.since) and.push({ timestamp: 'last_edited_time', last_edited_time: { on_or_after: o.since } });
  const sorts =
    o.sort === 'edited' ? [{ timestamp: 'last_edited_time', direction: 'ascending' }]
      : o.sort === 'released' ? [{ property: E.released, direction: 'descending' }]
        : [{ property: E.last, direction: 'descending' }];
  const res = await notion().query(dataSourceId, {
    ...(and.length ? { filter: and.length === 1 ? and[0] : { and } } : {}),
    sorts,
    page_size: Math.min(100, o.limit || 100),
    ...(o.cursor ? { start_cursor: o.cursor } : {}),
  });
  return { cards: res.results.map((p: any) => toCard(p)), cursor: res.has_more ? res.next_cursor : null };
}

/** Every episode of a show (all pages). */
export async function showEpisodes(show: string) {
  const out: { page: any; rec: Rec }[] = [];
  const { dataSourceId } = await episodesDb();
  for await (const page of notion().queryAll(dataSourceId, { filter: { property: E.show, select: { equals: selName(show) } } })) out.push({ page, rec: recordOf(page) });
  return out;
}

// ---------- writing ----------

// Requests for the same episode are applied one after another within an instance, so two quick
// flushes never create two pages.
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const prev = Promise.all(keys.map((k) => locks.get(k)).filter(Boolean));
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  for (const k of keys) locks.set(k, mine);
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
    for (const k of keys) if (locks.get(k) === mine) locks.delete(k);
  }
}

async function writeRecord(page: any | null, rec: Rec): Promise<any> {
  const { dataSourceId } = await episodesDb();
  const properties = propsOf(rec);
  const cover = rec.image ? { type: 'external', external: { url: rec.image } } : undefined;
  if (page) {
    const body: any = { properties };
    if (cover && page.cover?.external?.url !== rec.image) body.cover = cover;
    return notion().updatePage(page.id, body);
  }
  return notion().createPage({ parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties, ...(cover ? { cover } : {}), icon: { type: 'emoji', emoji: rec.sp && !rec.yt ? '🎧' : '▶️' } });
}

/** Merge duplicate pages of one episode into the oldest. The others are returned to be trashed once the merged record is saved. */
function collapse(pages: any[]): { page: any | null; rec: Rec | null; extras: any[] } {
  if (!pages.length) return { page: null, rec: null, extras: [] };
  const sorted = [...pages].sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time));
  let rec = recordOf(sorted[0]);
  for (const extra of sorted.slice(1)) rec = mergeRecords(rec, recordOf(extra)) as Rec;
  return { page: sorted[0], rec, extras: sorted.slice(1) };
}

const trash = async (pages: { id: string }[]) => {
  for (const p of pages) await notion().updatePage(p.id, { in_trash: true }).catch(() => {});
};

/** Whether a record counts as finished on its own evidence (after a pair was split). */
function ownFinish(rec: Rec, prev?: number): Rec {
  const out = { ...rec };
  delete out.finishedAt;
  if (summarize(out).finished) out.finishedAt = prev ?? Date.now();
  return out;
}

const unlinkedFrom = (rec: Rec | null, p: P, id: string) => !!rec?.unlinked?.includes(`${p}:${id}`);

/**
 * Apply progress events (from the extension, the account syncs, Shortcuts) and return the updated
 * cards. Events for the same episode are merged into one write; nothing is written when nothing changed.
 */
export async function applyEvents(events: EpisodeEvent[]): Promise<Card[]> {
  const groups = new Map<string, EpisodeEvent[]>();
  for (const ev of events) {
    if (!ev || (ev.p !== 'yt' && ev.p !== 'sp') || !ev.id) continue;
    const k = `${ev.p}:${ev.id}`;
    groups.set(k, [...(groups.get(k) || []), ev]);
  }
  const cards: Card[] = [];
  for (const [key, evs] of groups) {
    evs.sort((a, b) => (a.at || 0) - (b.at || 0));
    const head = evs[evs.length - 1];
    const twin = evs.map((e) => e.twin).find(Boolean) || null;
    const keys = [key, ...(twin ? [`${twin.p}:${twin.id}`] : [])];
    const card = await withLock(keys, async () => {
      const found = (await pagesFor([{ p: head.p, id: head.id }, ...(twin ? [twin] : [])])).map((page) => ({ page, rec: recordOf(page) }));
      const own = found.filter((x) => x.rec[head.p]?.id === head.id);
      const twinPages = twin ? found.filter((x) => !own.includes(x) && x.rec[twin.p]?.id === twin.id) : [];
      // Pair with the twin unless you separated them by hand or either one is already paired with something else.
      const useTwin =
        !!twin &&
        !found.some((x) => unlinkedFrom(x.rec, twin.p, twin.id) || unlinkedFrom(x.rec, head.p, head.id)) &&
        !own.some((x) => x.rec[twin.p]?.id && x.rec[twin.p]!.id !== twin.id) &&
        !twinPages.some((x) => x.rec[head.p]?.id && x.rec[head.p]!.id !== head.id);
      const group = (useTwin ? [...own, ...twinPages] : own).map((x) => x.page);
      const { page, rec, extras } = collapse(group);
      // Pages merged into one: always write the merged record (the others are in the trash now).
      const before = rec && group.length === 1 ? JSON.stringify(rec) : null;
      let next: Rec = rec ? { ...rec } : { v: 1 };
      for (const ev of evs) next = applyEvent(next, ev) as Rec;
      if (useTwin && twin && next[twin.p]?.id === twin.id && !next[twin.p]!.dur && twin.dur && twin.dur > 0) next[twin.p] = { ...next[twin.p]!, dur: twin.dur };
      if (useTwin && twin && !next[twin.p]) {
        next[twin.p] = { id: twin.id, ...(twin.dur && twin.dur > 0 ? { dur: twin.dur } : {}), ...(twin.title ? { title: twin.title } : {}) };
        next.linked = { by: twin.by || 'match', score: twin.score, at: Date.now() };
      }
      if (head.troveShow && next.show !== head.troveShow) next.show = head.troveShow;
      if (head.series !== undefined && next.seriesBy !== 'manual' && (next.series || null) !== (head.series || null)) {
        next.series = head.series || null;
        next.seriesBy = head.series ? 'auto' : null;
      }
      if (page && before === JSON.stringify(next)) return toCard(page, next);
      const written = await writeRecord(page, next);
      await trash(extras);
      return toCard(written, next);
    });
    cards.push(card);
  }
  return cards;
}

export type EpisodePatch = {
  status?: 'finished' | 'unfinished';
  title?: string;
  show?: string | null;
  series?: string | null;
  /** Link the same episode on the other platform: a YouTube/Spotify URL or "yt:<id>" / "sp:<id>". */
  link?: string;
  /** Separate one platform copy into its own page (a wrong automatic link). */
  unlink?: P;
  /** "I'm at …" on a platform (Shortcut, Trove app). */
  position?: { p: P; pos: number };
};

const refOf = (s: string): { p: P; id: string } | null => {
  const m = /^(yt|sp):([\w-]{11,22})$/.exec(s || '');
  if (m) return { p: m[1] as P, id: m[2] };
  const y = /youtu\.?be|youtube/.test(s || '') ? youtubeId(s) : null;
  if (y) return { p: 'yt', id: y };
  const sp = spotifyEpisodeId(s);
  return sp ? { p: 'sp', id: sp } : null;
};
export { refOf };

export async function patchEpisode(pageId: string, patch: EpisodePatch): Promise<{ card: Card; split?: Card }> {
  // Same lock as incoming progress, so an upload built from an older read can't undo the edit.
  const { rec: first } = await getEpisode(pageId);
  const link = patch.link ? refOf(patch.link) : null;
  if (patch.link && !link) throw Object.assign(new Error('Pass a YouTube or Spotify episode link'), { status: 400 });
  const keys = [first.yt?.id && `yt:${first.yt.id}`, first.sp?.id && `sp:${first.sp.id}`, link && `${link.p}:${link.id}`].filter(Boolean) as string[];
  return withLock(keys.length ? keys : [`page:${pageId}`], () => patchLocked(pageId, patch, link));
}

/** Whether a platform copy has anything played on it (and so is worth a page of its own). */
const played = (c: Copy) => !!(c.ranges?.length || c.pos || c.ext?.pos || c.ext?.done);

async function patchLocked(pageId: string, patch: EpisodePatch, link: { p: P; id: string } | null): Promise<{ card: Card; split?: Card }> {
  const { page, rec: base } = await getEpisode(pageId);
  let rec: Rec = { ...base };
  let split: Card | undefined;
  const toTrash: any[] = [];
  const now = Date.now();
  if (patch.status === 'finished') rec = markManual(rec, true, now) as Rec;
  if (patch.status === 'unfinished') rec = markManual(rec, false, now) as Rec;
  if (patch.title !== undefined && patch.title.trim()) rec.title = patch.title.trim();
  if (patch.show !== undefined) rec.show = patch.show || undefined;
  if (patch.series !== undefined) {
    rec.series = patch.series || null;
    rec.seriesBy = 'manual';
  }
  if (patch.position && rec[patch.position.p]?.id) rec = applyEvent(rec, { p: patch.position.p, id: rec[patch.position.p]!.id, pos: patch.position.pos, at: now, src: 'manual' }) as Rec;

  /** Move one platform copy out of this page into a page of its own. */
  const splitOff = async (p: P) => {
    const other: P = p === 'yt' ? 'sp' : 'yt';
    const copy = rec[p]!;
    // A copy you never played (paired by a search, say) needs no page of its own: the two just stay apart.
    if (played(copy)) {
      const moved: Rec = { v: 1, title: copy.title || rec.title, show: copy.show || copy.channel || rec.show, image: p === 'sp' ? copy.image : undefined, [p]: copy, unlinked: rec[other]?.id ? [`${other}:${rec[other]!.id}`] : [] };
      const created = await writeRecord(null, ownFinish(moved, rec.finishedAt));
      split = toCard(created, recordOf(created));
    }
    const prevFinish = rec.finishedAt;
    delete rec[p];
    rec.unlinked = [...new Set([...(rec.unlinked || []), `${p}:${copy.id}`])];
    delete rec.linked;
    if (rec[other]?.title) rec.title = rec[other]!.title;
    // Each half is finished only on its own evidence (a mark by hand stays with this page).
    rec = ownFinish(rec, prevFinish);
  };

  if (link) {
    const ref = link;
    const other: P = ref.p === 'yt' ? 'sp' : 'yt';
    // This page already holds a different copy on that platform: give it its own page first.
    if (rec[ref.p]?.id && rec[ref.p]!.id !== ref.id) {
      if (!rec[other]?.id) throw Object.assign(new Error(`This episode already is another ${PLATFORM_NAME[ref.p]} ${ref.p === 'yt' ? 'video' : 'episode'}`), { status: 400 });
      await splitOff(ref.p);
    }
    for (const o of (await pagesFor([ref])).filter((pg) => pg.id !== page.id)) {
      const orec = recordOf(o);
      if (orec[other]?.id && rec[other]?.id && orec[other]!.id !== rec[other]!.id) {
        // That page pairs it with another episode: take only its copy and leave the rest there.
        const { [ref.p]: copy, ...rest } = orec;
        rec[ref.p] = mergePlatform(rec[ref.p]?.id === ref.id ? rec[ref.p] : undefined, copy) as Copy;
        await writeRecord(o, ownFinish({ ...rest, unlinked: [...new Set([...(rest.unlinked || []), `${ref.p}:${ref.id}`])] } as Rec, rest.finishedAt));
      } else {
        rec = mergeRecords(rec, orec) as Rec;
        toTrash.push(o);
      }
    }
    if (!rec[ref.p] || rec[ref.p]!.id !== ref.id) rec[ref.p] = { id: ref.id };
    rec.unlinked = (rec.unlinked || []).filter((u) => u !== `${ref.p}:${ref.id}`);
    rec.linked = { by: 'manual', at: now };
    rec = settle(rec, now) as Rec;
  }
  if (patch.unlink && rec[patch.unlink] && rec[patch.unlink === 'yt' ? 'sp' : 'yt']) await splitOff(patch.unlink);
  const written = await writeRecord(page, rec);
  await trash(toTrash);
  return { card: toCard(written, rec), split };
}

export async function deleteEpisode(pageId: string) {
  await notion().updatePage(pageId, { in_trash: true });
}
