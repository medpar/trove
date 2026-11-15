// Server-side sync of what you played on any device (iPhone, iPad, Mac apps), no browser needed:
// Spotify through its web player's private API with your sp_dc sign-in, YouTube through your watch
// history with your YouTube sign-in cookies. Runs hourly (the Cloudflare worker's cron), when you
// close the Spotify or YouTube app on the iPhone (an iOS automation), and when you open Shows.
import 'server-only';
import { bestMatch, commonWords } from '../../extension/lib/progress.js';
import { applyEvents, type Card, type EpisodeEvent } from './episodes';
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
 * When an episode you had never been seen playing turns up already played (first import), the
 * best guess for when you heard it is a few days after it came out, not "now".
 */
const guessWhen = (e: SpEpisode, played: number) => {
  if (!e.released) return played;
  const r = Date.parse(e.released) + 3 * 864e5;
  return e.played?.done ? Math.min(played, r) : played;
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
        events.push(...spotifyChanges(st, page.episodes, (e, first) => (first ? guessWhen(e, when(ctx.at)) : when(ctx.at)), pending));
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
  for (const card of cards) {
    if (budget <= 0) break;
    if (card.sp && !card.yt) {
      budget--;
      const hits = await yt.search(`${card.title} ${card.show || ''}`.trim()).catch(() => []);
      const m = bestMatch({ title: card.title, dur: card.sp.dur, date: card.released }, hits.map((h) => ({ ...h, date: h.date })));
      if (m && m.d !== null && m.d >= 0.9) out.push({ p: 'sp', id: card.sp.id, twin: { p: 'yt', id: (m.c as YtVideo).id, by: 'search', score: m.score }, at: Date.now() });
    } else if (card.yt && !card.sp && card.show) {
      const shows = (st.spotify?.heard || []).filter((h) => commonWords([h.title, card.show!], 0.5).size > 0);
      for (const show of shows.slice(0, 2)) {
        budget--;
        let eps = showEpisodesCache.get(show.id);
        if (!eps) {
          eps = (await sp.showEpisodes(show.id, 0, 50).catch(() => ({ episodes: [] as SpEpisode[] }))).episodes;
          showEpisodesCache.set(show.id, eps);
        }
        const m = bestMatch({ title: card.title, dur: card.yt.dur }, eps.map((e) => ({ ...e, date: e.released })));
        if (m && m.d !== null && m.d >= 0.9) {
          out.push({ p: 'yt', id: card.yt.id, twin: { p: 'sp', id: (m.c as SpEpisode).id, by: 'search', score: m.score }, at: Date.now() });
          break;
        }
      }
    }
  }
  return out;
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
  let cards: Card[] = [];
  try {
    for (let i = 0; i < events.length && Date.now() < deadline; i += 25) {
      const batch = events.slice(i, i + 25);
      cards.push(...(await applyEvents(await withCatalog(batch))));
      for (const e of batch) {
        if (!e.mark) continue;
        const side = e.mark.side === 'spotify' ? (st.spotify ||= {}) : (st.youtube ||= {});
        (side.seen ||= {} as Record<string, any>)[e.mark.id] = e.mark.sig;
      }
    }
  } catch (e: any) {
    result.error = `Saving to Notion: ${e.message}`;
  }
  result.updated = cards.length;
  if (events.length > cards.length && !result.error) result.left = events.length - cards.length;
  if (Date.now() < deadline - 20_000) {
    const twins = await findTwins(cards.filter((c) => !(c.sp && c.yt)), st, { spDc: spc?.spDc }).catch(() => []);
    if (twins.length) cards = await applyEvents(twins);
    result.paired = twins.length;
  }
  if (st.spotify?.seen) st.spotify.seen = trim(st.spotify.seen);
  if (st.youtube?.seen) st.youtube.seen = trim(st.youtube.seen);
  if (JSON.stringify(st) !== before) await writeState(STATE, st);
  return result;
}

