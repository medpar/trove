// Server-side sync of what you played on any device (iPhone, iPad, Mac apps), no browser needed:
// Spotify through its web player's private API with your sp_dc sign-in, YouTube through your watch
// history with your YouTube sign-in cookies. Runs hourly (the Cloudflare worker's cron), when you
// close the Spotify or YouTube app on the iPhone (an iOS automation), and when you open Shows.
import 'server-only';
import { bestMatch, sameName } from '../../extension/lib/progress.js';
import { applyEvents, listEpisodes, lookupRefs, type Card, type EpisodeEvent } from './episodes';
import { hasYouTubeSession, InnerTube, parseCookies, YouTubeAuthError, type CookieJar, type YtVideo } from './innertube';
import { buildCatalog, listShows, staleShows, withCatalog } from './shows';
import { SpotifyAuthError, SpotifyWeb, type SpEpisode } from './spotify';
import { readState, writeState } from './state';
import { readSecret, writeSecret } from './vault';

export type SpotifyCreds = { spDc: string; user?: string; name?: string; savedAt: number };
export type YouTubeCreds = { jar: CookieJar; savedAt: number };

type Side = { at?: number; ok?: boolean; error?: string | null; auth?: boolean; events?: number };
type SyncState = {
  spotify?: Side & { seen?: Record<string, string>; shows?: Record<string, number>; libraryAt?: number; hashes?: Record<string, string>; heard?: { id: string; title: string }[] };
  youtube?: Side & { seen?: Record<string, number> };
  /** Episodes heard on only one platform, still to be looked up on the other (a first import brings hundreds). */
  twins?: string[];
  /** Which version of the twin search last looked up everything already in Notion. */
  twinSeed?: number;
  twinsSeeded?: number;
  /** Copies whose length Trove doesn't know yet (paired by a search, by hand, or by an older catalog). */
  lengths?: string[];
  /** When everything in Notion was last checked for missing lengths (daily). */
  lengthScan?: number;
  running?: number;
};

const STATE = 'media-sync.json';

// ---------- sign-ins ----------

export async function spotifyCreds(): Promise<SpotifyCreds | null> {
  const saved = await readSecret<SpotifyCreds>('spotify');
  if (saved?.spDc) return saved;
  const fromEnv = process.env.SPOTIFY_SP_DC?.trim();
  return fromEnv ? { spDc: fromEnv, savedAt: 0 } : null;
}

export async function youtubeCreds(): Promise<YouTubeCreds | null> {
  const saved = await readSecret<YouTubeCreds>('youtube');
  if (saved?.jar && hasYouTubeSession(saved.jar)) return saved;
  const fromEnv = process.env.YOUTUBE_COOKIES?.trim();
  if (fromEnv) {
    const jar = parseCookies(fromEnv);
    if (hasYouTubeSession(jar)) return { jar, savedAt: 0 };
  }
  return null;
}

/** Check and keep a Spotify sign-in (the sp_dc cookie from open.spotify.com). */
export async function connectSpotify(spDc: string) {
  const value = spDc.trim().replace(/^sp_dc=/, '').replace(/;.*$/, '');
  if (!/^[\w-]{40,}$/.test(value)) throw Object.assign(new Error('That does not look like an sp_dc cookie value'), { status: 400 });
  const sp = new SpotifyWeb({ spDc: value });
  await sp.accessToken(true);
  const me = await sp.profile();
  if (!me) throw Object.assign(new Error('Spotify accepted the cookie but returned no profile'), { status: 400 });
  await writeSecret('spotify', { spDc: value, user: me.username, name: me.name, savedAt: Date.now() } satisfies SpotifyCreds);
  await patchState((s) => ({ ...s, spotify: { ...s.spotify, auth: false, error: null } }));
  return me;
}

/** Check and keep a YouTube sign-in (cookies.txt, a Cookie header or a JSON cookie export). */
export async function connectYouTube(cookies: string | CookieJar) {
  const jar = typeof cookies === 'string' ? parseCookies(cookies) : cookies;
  if (!hasYouTubeSession(jar)) throw Object.assign(new Error('Those cookies have no YouTube sign-in (SAPISID / SID missing)'), { status: 400 });
  const yt = new InnerTube(jar);
  const videos = await yt.history(1);
  await writeSecret('youtube', { jar: yt.jar || jar, savedAt: Date.now() } satisfies YouTubeCreds);
  await patchState((s) => ({ ...s, youtube: { ...s.youtube, auth: false, error: null } }));
  return { videos: videos.length };
}

export async function disconnect(which: 'spotify' | 'youtube') {
  await writeSecret(which, null);
  await patchState((s) => ({ ...s, [which]: {} }));
}

async function patchState(fn: (s: SyncState) => SyncState) {
  const s = (await readState<SyncState>(STATE)) || {};
  await writeState(STATE, fn(s));
}

export async function syncStatus() {
  const [s, sp, yt, shows] = await Promise.all([readState<SyncState>(STATE), spotifyCreds(), youtubeCreds(), listShows()]);
  const side = (x: Side | undefined, connected: boolean, extra: Record<string, unknown> = {}) => ({ connected, at: x?.at || null, ok: x?.ok ?? null, error: x?.error || null, needsSignIn: !!x?.auth, ...extra });
  return {
    spotify: side(s?.spotify, !!sp, { user: sp?.name || sp?.user || null, fromEnv: !!sp && !sp.savedAt }),
    youtube: side(s?.youtube, !!yt, { fromEnv: !!yt && !yt.savedAt }),
    shows: shows.length,
  };
}

// ---------- sync ----------

const trim = <T>(m: Record<string, T>, max = 4000) => {
  const keys = Object.keys(m);
  return keys.length <= max ? m : Object.fromEntries(keys.slice(keys.length - max).map((k) => [k, m[k]]));
};

function spotifyEvent(e: SpEpisode, at: number): EpisodeEvent {
  return { p: 'sp', id: e.id, title: e.title, show: e.show || undefined, showId: e.showId || undefined, dur: e.dur || undefined, released: e.released || undefined, image: e.image || undefined, ext: { pos: e.played!.pos, done: e.played!.done, dur: e.dur || undefined }, at, src: 'spotify' };
}

/**
 * Played-state changes since the last sync as events (nothing for episodes you never started).
 * They are remembered as seen only once stored (see `mark`), so a sync cut short repeats them.
 */
type Pending = Map<string, string | number>;
function spotifyChanges(st: NonNullable<SyncState['spotify']>, episodes: SpEpisode[], at: (e: SpEpisode, first: boolean) => number, pendingSeen: Pending) {
  const seen = (st.seen ||= {});
  const out: EpisodeEvent[] = [];
  for (const e of episodes) {
    if (!e.played) continue;
    const sig = `${e.played.pos}|${e.played.done ? 1 : 0}`;
    const known = pendingSeen.get(`sp:${e.id}`) ?? seen[e.id];
    const first = known === undefined;
    if (known === sig) continue;
    if (first && !e.played.done && e.played.pos < 5) continue;
    pendingSeen.set(`sp:${e.id}`, sig);
    out.push({ ...spotifyEvent(e, at(e, first)), mark: { side: 'spotify', id: e.id, sig } });
  }
  return out;
}

/**
 * When an episode turns up already played on the first import, we don't know when you heard it.
 * Spotify's "last played" for its show is the best clue (for the one you're in the middle of);
 * otherwise a few days after it came out, never "now".
 */
const guessWhen = (e: SpEpisode, played: number, known = false) => {
  if (!e.released) return played;
  const r = Date.parse(e.released) + 3 * 864e5;
  return known && !e.played?.done ? played : Math.min(played, r);
};

async function syncSpotify(creds: SpotifyCreds, st: NonNullable<SyncState['spotify']>, { deep, deadline, pending }: { deep: boolean; deadline: number; pending: Pending }) {
  const sp = new SpotifyWeb({ spDc: creds.spDc, hashes: st.hashes });
  await sp.accessToken(); // fails early with a clear message when the sign-in expired
  const user = creds.user || (await sp.profile().catch(() => null))?.username;
  const events: EpisodeEvent[] = [];
  const firstRun = !st.at;
  const prev = st.at || 0;
  const since = deep || firstRun ? 0 : prev - 2 * 3600e3;
  // A change seen now happened after the previous sync; Spotify's "last played" says when exactly.
  const when = (played: number) => Math.min(Date.now(), Math.max(prev, played || Date.now()));
  // What you played lately on any device. If Spotify changes this endpoint, the library and the
  // followed shows below still get synced.
  const recent = user ? await sp.recentlyPlayed(user, 50).catch(() => []) : [];
  const scanned = (st.shows ||= {});
  const heard = new Map((st.heard || []).map((h) => [h.id, h]));
  for (const ctx of recent) {
    if (Date.now() > deadline) break;
    const [, kind, id] = ctx.uri.split(':');
    // A show played since the last sync: read all of it (an old episode may be the one you played).
    if (kind === 'show' && (ctx.at >= since || !scanned[id])) {
      const pages = ctx.at >= since || deep ? 20 : 1;
      for (let i = 0; i < pages && Date.now() < deadline; i++) {
        const page = await sp.showEpisodes(id, i * 50, 50);
        if (i === 0) heard.set(id, { id, title: page.title });
        events.push(...spotifyChanges(st, page.episodes, (e, first) => (first ? guessWhen(e, when(ctx.at), !!ctx.at) : when(ctx.at)), pending));
        if (page.episodes.length < 50) break;
      }
      scanned[id] = Date.now();
    }
    if (kind === 'episode' && ctx.at >= since) {
      const e = await sp.episode(id).catch(() => null);
      if (e) events.push(...spotifyChanges(st, [e], () => when(ctx.at), pending));
    }
  }
  // Once a day: the newest episodes of every show in Your Library (catches shows you haven't played lately).
  if (deep || Date.now() - (st.libraryAt || 0) > 22 * 3600e3) {
    for (const show of await sp.libraryShows().catch(() => [])) {
      if (Date.now() > deadline) break;
      heard.set(show.id, { id: show.id, title: show.title });
      try {
        const page = await sp.showEpisodes(show.id, 0, deep ? 50 : 20);
        events.push(...spotifyChanges(st, page.episodes, (e, first) => (first ? guessWhen(e, Date.now()) : when(0)), pending));
      } catch { /* a removed show */ }
    }
    st.libraryAt = Date.now();
  }
  st.heard = [...heard.values()].slice(-60);
  if (sp.hashesChanged) st.hashes = sp.hashes;
  return events;
}

async function syncYouTube(creds: YouTubeCreds, st: NonNullable<SyncState['youtube']>, { deep, pending: pendingSeen }: { deep: boolean; pending: Pending }) {
  const yt = new InnerTube({ ...creds.jar });
  const videos = await yt.history(deep || !st.at ? 5 : 2);
  const seen = (st.seen ||= {});
  const events: EpisodeEvent[] = [];
  const prev = st.at || 0;
  const now = Date.now();
  for (const v of videos) {
    if (v.pct === null || v.pct === undefined || !v.dur) continue;
    const known = pendingSeen.get(`yt:${v.id}`) ?? seen[v.id];
    if (known === v.pct) continue;
    const first = known === undefined;
    pendingSeen.set(`yt:${v.id}`, v.pct);
    // History only gives the day. Something that changed since the last sync was watched in between:
    // take the middle of that window, kept within the day YouTube files it under.
    const dayEnd = Math.min(now, v.watchedBy || now);
    const dayStart = new Date(dayEnd).setHours(0, 0, 0, 0);
    const at = first || !prev ? dayEnd : Math.max(dayStart, Math.min(dayEnd, Math.round((prev + now) / 2)));
    events.push({ ...youtubeEvent(v, at), mark: { side: 'youtube', id: v.id, sig: v.pct } });
  }
  if (yt.jarChanged && yt.jar) await writeSecret('youtube', { jar: yt.jar, savedAt: creds.savedAt });
  return events;
}

function youtubeEvent(v: YtVideo, at: number): EpisodeEvent {
  const pct = Math.max(0, Math.min(100, v.pct || 0));
  return { p: 'yt', id: v.id, title: v.title, channel: v.channel, channelId: v.channelId, dur: v.dur || undefined, ext: { pos: Math.round((pct / 100) * (v.dur || 0)), done: pct >= 95, dur: v.dur || undefined }, at, src: 'youtube' };
}

/**
 * Pair episodes outside followed shows: a Spotify episode with the YouTube video of the same title
 * and length, a YouTube video with an episode of a Spotify show named like its channel that you listen to.
 */
async function findTwins(cards: Card[], st: SyncState, { budget = 6, spDc }: { budget?: number; spDc?: string | null }) {
  const yt = new InnerTube();
  const sp = new SpotifyWeb({ spDc });
  const out: EpisodeEvent[] = [];
  const showEpisodesCache = new Map<string, SpEpisode[]>();
  let checked = 0;
  const taken = new Set<string>();
  // Lengths must agree closely, except on the show's own channel or feed, where ad reads often make
  // the podcast a few minutes longer than the video.
  const sure = (m: any, minD = 0.9) => (m && m.d !== null && m.d >= minD ? m : null);
  for (const card of cards) {
    if (budget <= 0) break;
    checked++;
    if (taken.has(refOf(card))) continue;
    if (card.sp && !card.yt) {
      budget--;
      const hits = await yt.search(`${card.title} ${card.show || ''}`.trim()).catch(() => [] as YtVideo[]);
      const pick = (list: YtVideo[], minD?: number) => sure(bestMatch({ title: card.title, dur: card.sp!.dur, date: card.released }, list.map((h) => ({ ...h, date: h.date }))), minD);
      // The show's own channel first: full re-uploads of popular episodes are common.
      const own = hits.filter((h) => sameName(h.channel, card.show));
      const m = (own.length ? pick(own, 0.7) : null) || pick(hits);
      if (m) {
        const v = m.c as YtVideo;
        out.push({ p: 'sp', id: card.sp.id, twin: { p: 'yt', id: v.id, by: 'search', score: m.score, dur: v.dur || undefined, title: v.title }, at: Date.now() });
        taken.add(`yt:${v.id}`);
      }
    } else if (card.yt && !card.sp && card.show) {
      const shows = (st.spotify?.heard || []).filter((h) => sameName(h.title, card.show));
      for (const show of shows.slice(0, 2)) {
        budget--;
        let eps = showEpisodesCache.get(show.id);
        if (!eps) {
          eps = (await sp.showEpisodes(show.id, 0, 50).catch(() => ({ episodes: [] as SpEpisode[] }))).episodes;
          showEpisodesCache.set(show.id, eps);
        }
        const m = sure(bestMatch({ title: card.title, dur: card.yt.dur }, eps.map((e) => ({ ...e, date: e.released }))), 0.7);
        if (m) {
          const ep = m.c as SpEpisode;
          out.push({ p: 'yt', id: card.yt.id, twin: { p: 'sp', id: ep.id, by: 'search', score: m.score, dur: ep.dur || undefined, title: ep.title }, at: Date.now() });
          taken.add(`sp:${ep.id}`);
          break;
        }
      }
    }
  }
  return { events: out, checked };
}

/** Bump to look every single-platform episode up again once (after the twin search gets better). */
const TWIN_SEARCH = 2;
const refOf = (c: Card) => (c.yt ? `yt:${c.yt.id}` : `sp:${c.sp?.id}`);
const single = (c: Card | null | undefined): c is Card => !!c && !!(c.yt || c.sp) && !(c.yt && c.sp);

/**
 * Lengths for platform copies Trove doesn't know yet, so a position maps exactly from one platform to
 * the other (a podcast with ad reads runs longer than its video).
 */
export async function lengthEvents(cards: Card[], { spDc, max = 20 }: { spDc?: string | null; max?: number } = {}) {
  const yt = new InnerTube();
  const sp = new SpotifyWeb({ spDc });
  const events: EpisodeEvent[] = [];
  let looked = 0;
  for (const card of cards) {
    for (const p of ['yt', 'sp'] as const) {
      const copy = card[p];
      if (!copy || copy.dur || looked >= max) continue;
      looked++;
      const info = p === 'yt' ? await yt.videoInfo(copy.id).catch(() => null) : await sp.episode(copy.id).catch(() => null);
      if (info?.dur) events.push({ p, id: copy.id, dur: info.dur, title: copy.title ? undefined : info.title || undefined, at: Date.now(), src: 'lookup' });
    }
  }
  return events;
}

const missingLength = (c: Card) => [c.yt && !c.yt.dur && `yt:${c.yt.id}`, c.sp && !c.sp.dur && `sp:${c.sp.id}`].filter(Boolean) as string[];
const LENGTH_SCAN_EVERY = 24 * 3600e3;

async function missingLengthRefs() {
  const refs: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 30; i++) {
    const page = await listEpisodes({ cursor, limit: 100 });
    for (const c of page.cards) refs.push(...missingLength(c));
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return refs;
}

/** Every episode heard on only one platform, most recent first (seeds the twin queue once). */
async function unpairedRefs() {
  const refs: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 30; i++) {
    const page = await listEpisodes({ cursor, limit: 100 });
    refs.push(...page.cards.filter(single).map(refOf));
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return refs;
}

/** Sync everything that is connected. `deep` re-reads more history (first import). */
let running: Promise<Record<string, any>> | null = null;
export function syncAll(opts: { deep?: boolean; only?: 'spotify' | 'youtube' | 'shows'; deadline?: number } = {}) {
  // One sync at a time per server instance (the hourly cron and opening Shows can coincide).
  running ||= runSync(opts).finally(() => (running = null));
  return running;
}

async function runSync({ deep = false, only, deadline = Date.now() + 240_000 }: { deep?: boolean; only?: 'spotify' | 'youtube' | 'shows'; deadline?: number }) {
  const pending: Pending = new Map();
  const st: SyncState = (await readState<SyncState>(STATE)) || {};
  const before = JSON.stringify(st);
  const result: Record<string, any> = {};
  const [spc, ytc] = await Promise.all([spotifyCreds(), youtubeCreds()]);
  const events: EpisodeEvent[] = [];

  if (spc && (!only || only === 'spotify')) {
    const side = (st.spotify ||= {});
    try {
      // Leave time for YouTube, a catalog and the writes.
      const evs = await syncSpotify(spc, side, { deep, deadline: deadline - Math.min(60_000, (deadline - Date.now()) / 4), pending });
      events.push(...evs);
      Object.assign(side, { at: Date.now(), ok: true, error: null, auth: false, events: evs.length });
      result.spotify = { events: evs.length };
    } catch (e: any) {
      Object.assign(side, { ok: false, error: e.message, auth: e instanceof SpotifyAuthError });
      result.spotify = { error: e.message };
    }
  }

  if (ytc && (!only || only === 'youtube')) {
    const side = (st.youtube ||= {});
    try {
      const evs = await syncYouTube(ytc, side, { deep, pending });
      events.push(...evs);
      Object.assign(side, { at: Date.now(), ok: true, error: null, auth: false, events: evs.length });
      result.youtube = { events: evs.length };
    } catch (e: any) {
      Object.assign(side, { ok: false, error: e.message, auth: e instanceof YouTubeAuthError });
      result.youtube = { error: e.message };
    }
  }

  // One stale followed show per run: refresh its catalog (with your Spotify played state).
  if (!only || only === 'shows') {
    const stale = await staleShows().catch(() => []);
    if (stale[0] && Date.now() < deadline - 90_000) {
      try {
        const c = await buildCatalog(stale[0], { spDc: spc?.spDc, deadline: deadline - 30_000 });
        if (spc) events.push(...spotifyChanges((st.spotify ||= {}), c.sp, (e, first) => (first ? guessWhen(e, Date.now()) : Date.now()), pending));
        result.catalog = { show: stale[0].title, spotify: c.sp.length, youtube: c.yt.length, paired: Object.keys(c.pairs).length, error: c.error || null };
      } catch (e: any) {
        result.catalog = { show: stale[0].title, error: e.message };
      }
    }
  }

  // Store the events; each one is remembered as seen only once it is in Notion.
  const cards: Card[] = [];
  let applied = 0;
  try {
    for (let i = 0; i < events.length && Date.now() < deadline; i += 25) {
      const batch = events.slice(i, i + 25);
      cards.push(...(await applyEvents(await withCatalog(batch))));
      for (const e of batch) {
        if (!e.mark) continue;
        const side = e.mark.side === 'spotify' ? (st.spotify ||= {}) : (st.youtube ||= {});
        (side.seen ||= {} as Record<string, any>)[e.mark.id] = e.mark.sig;
      }
      applied = i + batch.length;
    }
  } catch (e: any) {
    result.error = `Saving to Notion: ${e.message}`;
  }
  // Several plays of one episode land on one card, so count what was left unsaved by events.
  result.updated = cards.length;
  if (applied < events.length && !result.error) result.left = events.length - applied;

  // Look for the other platform's copy of what you heard on only one: this run's episodes first, then
  // the ones earlier runs had no time for. A few lookups per run, so a big first import catches up hourly.
  const fresh = new Map(cards.filter(single).map((c) => [refOf(c), c]));
  let queue = [...new Set([...fresh.keys(), ...(st.twins || [])])];
  if ((st.twinSeed || 0) < TWIN_SEARCH && Date.now() < deadline - 60_000) {
    try {
      queue = [...new Set([...queue, ...(await unpairedRefs())])];
      st.twinSeed = TWIN_SEARCH;
      delete st.twinsSeeded;
    } catch { /* next run */ }
  }
  if (queue.length && Date.now() < deadline - 20_000) {
    const head = queue.slice(0, 60);
    let known: Record<string, Card | null> | null = null;
    try {
      known = await lookupRefs(head.filter((r) => !fresh.has(r)));
    } catch { /* keep them queued */ }
    const cardOf = (r: string) => fresh.get(r) || known?.[r];
    const candidates = head.map(cardOf).filter(single);
    try {
      const { events: twins, checked } = await findTwins(candidates, st, { spDc: spc?.spDc });
      // Done with: what was looked up, and what is gone or got paired meanwhile.
      const settled = new Set(candidates.slice(0, checked).map(refOf));
      if (known) for (const r of head) if (!single(cardOf(r))) settled.add(r);
      queue = queue.filter((r) => !settled.has(r));
      if (twins.length) await applyEvents(twins);
      result.paired = twins.length;
    } catch (e: any) {
      result.pairing = e.message;
    }
  }
  st.twins = queue.length ? queue.slice(0, 3000) : undefined;
  if (queue.length) result.toPair = queue.length;

  // Lengths of copies paired without one, a few per run: this run's first.
  let lengths = [...new Set([...cards.flatMap(missingLength), ...(st.lengths || [])])];
  // Once a day, everything in Notion (copies linked by hand when the lookup failed, older pairs).
  if (Date.now() - (st.lengthScan || 0) > LENGTH_SCAN_EVERY && Date.now() < deadline - 30_000) {
    try {
      lengths = [...new Set([...lengths, ...(await missingLengthRefs())])];
      st.lengthScan = Date.now();
    } catch { /* next run */ }
  }
  if (lengths.length && Date.now() < deadline - 15_000) {
    const head = lengths.slice(0, 20);
    try {
      const found = await lookupRefs(head);
      const cards = [...new Map(Object.values(found).filter((c): c is Card => !!c).map((c) => [c.id, c])).values()];
      const events = (await lengthEvents(cards, { spDc: spc?.spDc, max: 20 })).filter((e) => head.includes(`${e.p}:${e.id}`));
      if (events.length) await applyEvents(events);
      result.lengths = events.length;
      lengths = lengths.slice(head.length);
    } catch (e: any) {
      result.lengthsError = e.message;
    }
  }
  st.lengths = lengths.length ? lengths.slice(0, 3000) : undefined;
  if (st.spotify?.seen) st.spotify.seen = trim(st.spotify.seen);
  if (st.youtube?.seen) st.youtube.seen = trim(st.youtube.seen);
  if (JSON.stringify(st) !== before) await writeState(STATE, st);
  return result;
}

