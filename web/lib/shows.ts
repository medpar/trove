// Shows you follow in Trove: a podcast on Spotify and/or a channel on YouTube, with every episode
// listed once, the YouTube and Spotify copies paired, and grouped into series. Spotify has no
// playlists for series (the YC podcast mixes Lightcone, How To Build The Future, Startup School…),
// so series come from the show's YouTube playlists (through the pairing), from title rules, or by hand.
// Show settings live in Blob state (shows.json); each show's catalog is cached in catalog/<id>.json.
import 'server-only';
import { commonWords, matchAll, seriesFor, spotifyShowId, suggestSeries, titleSimilarity } from '../../extension/lib/progress.js';
import { applyEvents, lookupRefs, showEpisodes, toCard, type Card, type EpisodeEvent, type P } from './episodes';
import { InnerTube, type YtPlaylist, type YtVideo } from './innertube';
import { SpotifyWeb, type SpEpisode } from './spotify';
import { readState, writeState } from './state';

export type SeriesRule = { series: string; pattern: string };
export type ShowPlaylist = { id: string; title: string; series: string | null };
export type Show = {
  id: string;
  title: string;
  image: string | null;
  added: string;
  spotify: { id: string; title: string } | null;
  youtube: { channelId: string | null; title: string; playlists: ShowPlaylist[]; uploads: boolean } | null;
  rules: SeriesRule[];
  /** Pairs you made by hand (Spotify id -> YouTube id) and pairs you broke ("sp|yt"). */
  links: Record<string, string>;
  unlinks: string[];
};
type CatVideo = YtVideo & { playlists: string[] };
type Catalog = {
  v: 1;
  at: number;
  sp: SpEpisode[];
  yt: CatVideo[];
  /** Spotify id -> {YouTube id, how it was paired} */
  pairs: Record<string, { yt: string; score: number; by: string }>;
  /** Exact publish dates looked up for YouTube videos (playlists only give "2 years ago"). */
  dates: Record<string, string | null>;
  playlists?: YtPlaylist[];
  error?: string | null;
};
export type Row = {
  key: string;
  title: string;
  date: string | null;
  dur: number | null;
  series: string | null;
  description?: string;
  image: string | null;
  sp: { id: string; dur: number | null; title: string } | null;
  yt: { id: string; dur: number | null; title: string } | null;
  pairedBy?: string;
  card: Card | null;
};

// ---------- settings ----------

let showsCache: { at: number; shows: Show[] } | null = null;

export async function listShows(fresh = false): Promise<Show[]> {
  if (!fresh && showsCache && Date.now() - showsCache.at < 60_000) return showsCache.shows;
  const shows = (await readState<{ shows: Show[] }>('shows.json'))?.shows || [];
  showsCache = { at: Date.now(), shows };
  return shows;
}

async function saveShows(shows: Show[]) {
  await writeState('shows.json', { shows });
  showsCache = { at: Date.now(), shows };
  indexCache = null;
}

export async function getShow(id: string) {
  const s = (await listShows()).find((x) => x.id === id);
  if (!s) throw Object.assign(new Error('Unknown show'), { status: 404 });
  return s;
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'show';
const cleanSeries = (t: string) => t.replace(/\s+(podcast|playlist)$/i, '').trim();
/** A playlist's name as a series ("Lightcone Podcast" -> "Lightcone"), unless that leaves just the show's own name. */
const seriesName = (title: string, show: Show) => {
  const short = cleanSeries(title);
  const own = [show.title, show.youtube?.title, show.spotify?.title].filter(Boolean).map((t) => t!.toLowerCase());
  return own.some((t) => t === short.toLowerCase() || t.startsWith(`${short.toLowerCase()} `)) ? title.trim() : short;
};

// ---------- catalogs ----------

const catalogs = new Map<string, Catalog>();

export async function readCatalog(id: string): Promise<Catalog | null> {
  const hit = catalogs.get(id);
  if (hit) return hit;
  const c = await readState<Catalog>(`catalog/${id}.json`);
  if (c) catalogs.set(id, c);
  return c;
}

async function saveCatalog(id: string, c: Catalog) {
  catalogs.set(id, c);
  indexCache = null;
  await writeState(`catalog/${id}.json`, c);
}

/** Pair a show's Spotify episodes with its YouTube videos: titles first, then exact length + same publish day. */
async function pairCatalog(show: Show, c: Catalog, yt: InnerTube, { dateBudget = 40, deadline = Date.now() + 60_000 } = {}) {
  const unlinked = new Set(show.unlinks);
  const A = c.sp.map((e) => ({ id: e.id, title: e.title, dur: e.dur, date: e.released }));
  const B = c.yt.map((v) => ({ id: v.id, title: v.title, dur: v.dur, date: c.dates[v.id] || v.date || null }));
  const stop = commonWords([...A, ...B].map((x) => x.title));
  const pairs: Catalog['pairs'] = {};
  const usedB = new Set<string>();
  for (const [s, y] of Object.entries(show.links)) {
    pairs[s] = { yt: y, score: 1, by: 'manual' };
    usedB.add(y);
  }
  for (const m of matchAll(A.filter((a) => !pairs[a.id]), B.filter((b) => !usedB.has(b.id)), { stop, skip: (a: any, b: any) => unlinked.has(`${a.id}|${b.id}`) })) {
    pairs[m.a.id] = { yt: m.b.id, score: m.score, by: 'title' };
    usedB.add(m.b.id);
  }
  // Retitled episodes: same length to the second, published the same day.
  let budget = dateBudget;
  for (const a of A) {
    if (pairs[a.id] || !a.dur || !a.date || Date.now() > deadline) continue;
    const exact = B.filter((b) => !usedB.has(b.id) && b.dur && Math.abs(b.dur - a.dur!) <= 3 && !unlinked.has(`${a.id}|${b.id}`));
    if (!exact.length) continue;
    const ranked = exact.map((b) => ({ b, t: titleSimilarity(a.title, b.title, stop) })).sort((x, y) => y.t - x.t).slice(0, 3);
    for (const r of ranked) {
      if (c.dates[r.b.id] === undefined && budget > 0) {
        budget--;
        c.dates[r.b.id] = await yt.videoDate(r.b.id).catch(() => null);
      }
    }
    const sameDay = ranked.filter((r) => c.dates[r.b.id] && Math.abs(Date.parse(c.dates[r.b.id]!) - Date.parse(a.date!)) <= 2.5 * 864e5);
    if (sameDay.length === 1) {
      pairs[a.id] = { yt: sameDay[0].b.id, score: 0.8, by: 'length+date' };
      usedB.add(sameDay[0].b.id);
    }
  }
  c.pairs = pairs;
}

/** Fetch a show's episodes on both platforms and pair them. Uses your Spotify sign-in when given (played state comes along). */
export async function buildCatalog(show: Show, { spDc, deadline = Date.now() + 200_000, scanAllPlaylists = false }: { spDc?: string | null; deadline?: number; scanAllPlaylists?: boolean } = {}) {
  const prev = (await readCatalog(show.id)) || ({ v: 1, at: 0, sp: [], yt: [], pairs: {}, dates: {} } as Catalog);
  const c: Catalog = { ...prev, v: 1, dates: { ...(prev.dates || {}) }, error: null };
  const yt = new InnerTube();
  const errors: string[] = [];
  if (show.spotify) {
    try {
      c.sp = (await new SpotifyWeb({ spDc }).allEpisodes(show.spotify.id, 1500)).episodes;
    } catch (e: any) {
      errors.push(`Spotify: ${e.message}`);
    }
  }
  if (show.youtube) {
    try {
      const videos = new Map<string, CatVideo>();
      const add = (v: YtVideo, playlist?: string) => {
        const x = videos.get(v.id) || { ...v, playlists: [] };
        if (playlist && !x.playlists.includes(playlist)) x.playlists.push(playlist);
        videos.set(v.id, x);
      };
      let lists = show.youtube.playlists.map((p) => ({ id: p.id, title: p.title }));
      if (scanAllPlaylists && show.youtube.channelId) {
        c.playlists = await yt.channelPlaylists(show.youtube.channelId, 6);
        lists = c.playlists.filter((p) => (p.count || 0) >= 2).slice(0, 45);
      }
      for (const p of lists) {
        if (Date.now() > deadline - 40_000) break;
        try {
          for (const v of (await yt.playlistVideos(p.id, 600)).videos) add(v, p.id);
        } catch (e: any) {
          errors.push(`playlist ${p.title}: ${e.message}`);
        }
      }
      if (show.youtube.uploads && show.youtube.channelId) {
        for (const v of (await yt.playlistVideos(`UU${show.youtube.channelId.slice(2)}`, 1500)).videos) add(v);
      }
      c.yt = [...videos.values()];
    } catch (e: any) {
      errors.push(`YouTube: ${e.message}`);
    }
  }
  await pairCatalog(show, c, yt, { dateBudget: scanAllPlaylists ? 120 : 40, deadline });
  c.at = Date.now();
  c.error = errors.join('; ') || null;
  await saveCatalog(show.id, c);
  return c;
}

// ---------- following ----------

/** Follow a show from a Spotify show link and/or a YouTube channel or playlist link (either may be guessed from the other). */
export async function followShow(input: { spotify?: string; youtube?: string; title?: string }, { spDc }: { spDc?: string | null } = {}) {
  const sp = new SpotifyWeb({ spDc });
  const yt = new InnerTube();
  const spId = input.spotify ? spotifyShowId(input.spotify) || (/^[A-Za-z0-9]{22}$/.test(input.spotify.trim()) ? input.spotify.trim() : null) : null;
  if (input.spotify && !spId) throw Object.assign(new Error('That is not a Spotify show link'), { status: 400 });
  const spShow = spId ? await sp.show(spId) : null;
  let youtube: Show['youtube'] = null;
  const yIn = input.youtube?.trim();
  const listId = yIn ? /[?&]list=([\w-]+)/.exec(yIn)?.[1] : null;
  if (listId) {
    const { title, videos } = await yt.playlistVideos(listId, 50);
    youtube = { channelId: videos[0]?.channelId || null, title, playlists: [{ id: listId, title, series: null }], uploads: false };
  } else if (yIn) {
    const ch = await yt.resolveChannel(yIn);
    if (!ch) throw Object.assign(new Error('Could not find that YouTube channel'), { status: 400 });
    youtube = { channelId: ch.id, title: ch.title, playlists: [], uploads: true };
  } else if (spShow) {
    // Guess the channel: a YouTube video with the latest episode's title, from a channel named like the show.
    const latest = (await sp.showEpisodes(spShow.id, 0, 3)).episodes;
    for (const e of latest) {
      const hits = await yt.search(e.title).catch(() => []);
      const hit = hits.find((v) => v.channelId && titleSimilarity(v.title, e.title) >= 0.85 && (!e.dur || !v.dur || Math.abs(v.dur - e.dur) <= Math.max(30, e.dur * 0.05)));
      if (hit?.channelId) {
        const ch = await yt.resolveChannel(hit.channelId);
        if (ch) youtube = { channelId: ch.id, title: ch.title, playlists: [], uploads: true };
        break;
      }
    }
  }
  if (!spShow && !youtube) throw Object.assign(new Error('Pass a Spotify show link and/or a YouTube channel or playlist'), { status: 400 });
  const title = input.title?.trim() || spShow?.title || youtube!.title;
  const shows = await listShows(true);
  const existing = shows.find((s) => (spShow && s.spotify?.id === spShow.id) || (youtube?.channelId && s.youtube?.channelId === youtube.channelId && !listId));
  if (existing) return existing;
  let id = slug(title);
  while (shows.some((s) => s.id === id)) id = `${id}-2`;
  const show: Show = { id, title, image: spShow?.image || null, added: new Date().toISOString(), spotify: spShow ? { id: spShow.id, title: spShow.title } : null, youtube, rules: [], links: {}, unlinks: [] };
  await saveShows([...shows, show]);
  return show;
}

/**
 * First build: read every playlist of the channel, keep as series the ones that hold episodes of the
 * show (the "Lightcone Podcast", "How to Build the Future"… playlists for YC), then file the episodes
 * you already played under the show.
 */
export async function setupShow(id: string, { spDc }: { spDc?: string | null } = {}) {
  const show = await getShow(id);
  const c = await buildCatalog(show, { spDc, scanAllPlaylists: !!show.youtube?.channelId && !show.youtube.playlists.length });
  if (show.youtube && !show.youtube.playlists.length && c.playlists) {
    const paired = new Set(Object.values(c.pairs).map((p) => p.yt));
    const counts = new Map<string, number>();
    for (const v of c.yt) if (paired.has(v.id) || !show.spotify) for (const pl of v.playlists) counts.set(pl, (counts.get(pl) || 0) + 1);
    const keep = c.playlists.filter((p) => (counts.get(p.id) || 0) >= 2).sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0));
    show.youtube.playlists = keep.map((p) => ({ id: p.id, title: p.title, series: seriesName(p.title, show) }));
    // Keep only the videos of the chosen playlists (and the uploads) from now on.
    const kept = new Set(keep.map((p) => p.id));
    c.yt = c.yt.map((v) => ({ ...v, playlists: v.playlists.filter((p) => kept.has(p)) }));
    await saveCatalog(show.id, c);
  }
  if (!show.rules.length) {
    const titles = c.sp.length ? c.sp.map((e) => e.title) : c.yt.map((v) => v.title);
    const known = new Set((show.youtube?.playlists || []).map((p) => (p.series || '').toLowerCase()));
    show.rules = suggestSeries(titles, 3)
      .filter((s) => !known.has(s.name.toLowerCase()))
      .slice(0, 6)
      .map((s) => ({ series: cleanSeries(s.name), pattern: s.name }));
  }
  const shows = await listShows(true);
  await saveShows(shows.map((s) => (s.id === show.id ? show : s)));
  await refile(show, c);
  return show;
}

export async function updateShow(id: string, patch: Partial<Pick<Show, 'title' | 'rules' | 'image'>> & { playlists?: ShowPlaylist[]; uploads?: boolean; link?: { sp: string; yt: string }; unlink?: { sp: string; yt: string } }) {
  const shows = await listShows(true);
  const show = shows.find((s) => s.id === id);
  if (!show) throw Object.assign(new Error('Unknown show'), { status: 404 });
  const oldTitle = show.title;
  if (patch.title?.trim()) show.title = patch.title.trim();
  if (patch.image !== undefined) show.image = patch.image;
  if (patch.rules) show.rules = patch.rules.filter((r) => r.series?.trim() && r.pattern?.trim()).map((r) => ({ series: r.series.trim(), pattern: r.pattern.trim() }));
  if (patch.playlists && show.youtube) show.youtube.playlists = patch.playlists.map((p) => ({ id: p.id, title: p.title, series: p.series?.trim() || null }));
  if (patch.uploads !== undefined && show.youtube) show.youtube.uploads = patch.uploads;
  if (patch.link) {
    show.links[patch.link.sp] = patch.link.yt;
    show.unlinks = show.unlinks.filter((u) => u !== `${patch.link!.sp}|${patch.link!.yt}`);
  }
  if (patch.unlink) {
    delete show.links[patch.unlink.sp];
    show.unlinks = [...new Set([...show.unlinks, `${patch.unlink.sp}|${patch.unlink.yt}`])];
  }
  await saveShows(shows);
  const c = await readCatalog(id);
  if (c && (patch.link || patch.unlink)) {
    await pairCatalog(show, c, new InnerTube(), { dateBudget: 0 });
    await saveCatalog(id, c);
  }
  if (c && (patch.playlists || patch.rules || patch.link || patch.unlink || show.title !== oldTitle)) await refile(show, c);
  return show;
}

export async function unfollowShow(id: string) {
  await saveShows((await listShows(true)).filter((s) => s.id !== id));
  catalogs.delete(id);
}

// ---------- series & rows ----------

function seriesOf(show: Show, c: Catalog, sp: SpEpisode | undefined, yt: CatVideo | undefined): string | null {
  for (const p of show.youtube?.playlists || []) if (p.series && yt?.playlists.includes(p.id)) return p.series;
  return seriesFor(sp?.title || yt?.title || '', show.rules) || (sp?.description ? seriesFor(sp.description, show.rules.filter((r) => r.pattern.length > 6)) : null);
}

/** Catalog entries as rows (one per episode, both platforms together). */
function rowsOf(show: Show, c: Catalog): Omit<Row, 'card'>[] {
  const ytById = new Map(c.yt.map((v) => [v.id, v]));
  const pairedYt = new Set(Object.values(c.pairs).map((p) => p.yt));
  const rows: Omit<Row, 'card'>[] = [];
  for (const e of c.sp) {
    const pair = c.pairs[e.id];
    const v = pair ? ytById.get(pair.yt) : undefined;
    rows.push({
      key: `sp:${e.id}`,
      title: e.title,
      date: e.released,
      dur: e.dur,
      series: seriesOf(show, c, e, v),
      description: e.description,
      image: e.image,
      sp: { id: e.id, dur: e.dur, title: e.title },
      yt: v ? { id: v.id, dur: v.dur || null, title: v.title } : pair ? { id: pair.yt, dur: null, title: '' } : null,
      pairedBy: pair?.by,
    });
  }
  // YouTube-only episodes: videos in the show's playlists (or all uploads when there is no Spotify side).
  for (const v of c.yt) {
    if (pairedYt.has(v.id)) continue;
    if (show.spotify && !v.playlists.length) continue;
    rows.push({ key: `yt:${v.id}`, title: v.title, date: c.dates[v.id] || v.date || null, dur: v.dur || null, series: seriesOf(show, c, undefined, v), image: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, sp: null, yt: { id: v.id, dur: v.dur || null, title: v.title } });
  }
  return rows;
}

/** Make the episodes you already played belong to the show (and its series, and their twins). */
async function refile(show: Show, c: Catalog) {
  const rows = rowsOf(show, c);
  const refs = rows.flatMap((r) => [r.sp && `sp:${r.sp.id}`, r.yt && `yt:${r.yt.id}`].filter(Boolean) as string[]);
  const cards = new Map<string, Card>();
  for (let i = 0; i < refs.length; i += 100) {
    const found = await lookupRefs(refs.slice(i, i + 100));
    for (const card of Object.values(found)) if (card) cards.set(card.id, card);
  }
  const events: EpisodeEvent[] = [];
  for (const r of rows) {
    const card = [...cards.values()].find((k) => (r.sp && k.sp?.id === r.sp.id) || (r.yt && k.yt?.id === r.yt.id));
    if (!card) continue;
    const twinNeeded = r.sp && r.yt && (!card.sp || !card.yt);
    if (card.show === show.title && (card.series || null) === (r.series || null) && !twinNeeded) continue;
    const p: P = card.sp ? 'sp' : 'yt';
    const id = (p === 'sp' ? card.sp : card.yt)!.id;
    const twin = twinNeeded ? (p === 'sp' ? { p: 'yt' as P, id: r.yt!.id, by: r.pairedBy } : { p: 'sp' as P, id: r.sp!.id, by: r.pairedBy }) : null;
    events.push({ p, id, troveShow: show.title, series: r.series, twin, at: Date.now() });
  }
  for (let i = 0; i < events.length; i += 20) await applyEvents(events.slice(i, i + 20));
}

/** The show page: every episode with its series and your progress. */
export async function showView(id: string) {
  const show = await getShow(id);
  const c = await readCatalog(id);
  const rows = c ? rowsOf(show, c) : [];
  const played = await showEpisodes(show.title);
  const byRef = new Map<string, Card>();
  for (const { page, rec } of played) {
    const card = toCard(page, rec);
    if (card.sp) byRef.set(`sp:${card.sp.id}`, card);
    if (card.yt) byRef.set(`yt:${card.yt.id}`, card);
  }
  const out: Row[] = rows.map((r) => {
    const card = (r.sp && byRef.get(`sp:${r.sp.id}`)) || (r.yt && byRef.get(`yt:${r.yt.id}`)) || null;
    return { ...r, series: card?.series && card.series !== r.series ? card.series : r.series, card };
  });
  // Episodes you played that the catalog doesn't list (older, removed, or from another channel).
  const listed = new Set(out.flatMap((r) => [r.sp && `sp:${r.sp.id}`, r.yt && `yt:${r.yt.id}`].filter(Boolean)));
  for (const card of new Set(byRef.values())) {
    if ((card.sp && listed.has(`sp:${card.sp.id}`)) || (card.yt && listed.has(`yt:${card.yt.id}`))) continue;
    out.push({ key: card.sp ? `sp:${card.sp.id}` : `yt:${card.yt!.id}`, title: card.title, date: card.released, dur: card.sp?.dur || card.yt?.dur || null, series: card.series, image: card.image, sp: card.sp && { id: card.sp.id, dur: card.sp.dur, title: card.sp.title || card.title }, yt: card.yt && { id: card.yt.id, dur: card.yt.dur, title: card.yt.title || card.title }, card });
  }
  out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const series = new Map<string, { name: string; count: number; finished: number; started: number }>();
  for (const r of out) {
    const name = r.series || 'Other';
    const s = series.get(name) || { name, count: 0, finished: 0, started: 0 };
    s.count++;
    if (r.card?.status === 'finished') s.finished++;
    else if (r.card?.status === 'started') s.started++;
    series.set(name, s);
  }
  return {
    show,
    catalog: c ? { at: c.at, error: c.error || null, spotify: c.sp.length, youtube: c.yt.length, paired: Object.keys(c.pairs).length } : null,
    series: [...series.values()].sort((a, b) => (a.name === 'Other' ? 1 : b.name === 'Other' ? -1 : b.count - a.count)),
    episodes: out,
  };
}

/** Playlists of the show's channel, to pick series from. */
export async function showPlaylists(id: string) {
  const show = await getShow(id);
  const c = await readCatalog(id);
  if (c?.playlists?.length) return c.playlists;
  if (!show.youtube?.channelId) return [];
  const lists = await new InnerTube().channelPlaylists(show.youtube.channelId, 6);
  if (c) await saveCatalog(id, { ...c, playlists: lists });
  return lists;
}

// ---------- index for events ----------

type IndexEntry = { show: string; series: string | null; twin: { p: P; id: string; by: string } | null };
let indexCache: { at: number; map: Map<string, IndexEntry> } | null = null;

async function catalogIndex() {
  if (indexCache && Date.now() - indexCache.at < 10 * 60_000) return indexCache.map;
  const map = new Map<string, IndexEntry>();
  for (const show of await listShows()) {
    const c = await readCatalog(show.id);
    if (!c) continue;
    for (const r of rowsOf(show, c)) {
      if (r.sp) map.set(`sp:${r.sp.id}`, { show: show.title, series: r.series, twin: r.yt ? { p: 'yt', id: r.yt.id, by: r.pairedBy || 'title' } : null });
      if (r.yt) map.set(`yt:${r.yt.id}`, { show: show.title, series: r.series, twin: r.sp ? { p: 'sp', id: r.sp.id, by: r.pairedBy || 'title' } : null });
    }
  }
  indexCache = { at: Date.now(), map };
  return map;
}

/** Add the followed show, series and twin to events for episodes Trove knows from a catalog. */
export async function withCatalog(events: EpisodeEvent[]): Promise<EpisodeEvent[]> {
  const idx = await catalogIndex().catch(() => new Map<string, IndexEntry>());
  return events.map((e) => {
    const hit = idx.get(`${e.p}:${e.id}`);
    if (!hit) return e;
    return { ...e, troveShow: e.troveShow || hit.show, series: e.series !== undefined ? e.series : hit.series, twin: e.twin || hit.twin };
  });
}

/** Shows whose catalog is older than `maxAge` (refreshed by the hourly sync, one at a time). */
export async function staleShows(maxAge = 20 * 3600e3) {
  const out: Show[] = [];
  for (const s of await listShows()) {
    const c = await readCatalog(s.id);
    if (!c || Date.now() - c.at > maxAge) out.push(s);
  }
  return out;
}
