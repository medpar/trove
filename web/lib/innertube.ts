// YouTube through InnerTube, the private API youtube.com itself uses (the same one YouTube.js and
// yt-dlp use). Public calls (channels, playlists, search) need nothing; your watch history needs
// your YouTube sign-in as cookies, ideally exported from a private window that you then close, so
// the browser never rotates them. Trove keeps the cookies it is sent back up to date, like a browser.
// No server-only import: the parsers are unit-tested.
import { createHash } from 'node:crypto';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const ORIGIN = 'https://www.youtube.com';
const FALLBACK_VERSION = '2.20251020.01.00';

export class YouTubeAuthError extends Error {
  code = 'youtube_auth';
}

export type YtVideo = {
  id: string;
  title: string;
  channel?: string;
  channelId?: string;
  dur?: number | null;
  /** ISO date, only when YouTube gives one precise to a few days ("3 days ago", "Nov 3, 2026"). */
  date?: string | null;
  /** How much of it YouTube says you watched (0-100), from the red bar. */
  pct?: number | null;
  /** History only: the end of the day it was watched ("Today", "Yesterday", "Nov 3"). */
  watchedBy?: number | null;
  views?: number | null;
};
export type YtPlaylist = { id: string; title: string; count: number | null; kind: 'playlist' | 'podcast' };

// ---------- cookies ----------

export type CookieJar = Record<string, string>;

/** Netscape cookies.txt, a "Cookie:" header, or a JSON export (array of {name, value, domain}). */
export function parseCookies(input: string, domain = 'youtube.com'): CookieJar {
  const jar: CookieJar = {};
  const text = String(input || '').trim();
  if (!text) return jar;
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const arr = JSON.parse(text);
      for (const c of Array.isArray(arr) ? arr : arr.cookies || []) if (c?.name && (!c.domain || String(c.domain).includes(domain))) jar[c.name] = String(c.value ?? '');
      return jar;
    } catch { /* not JSON */ }
  }
  if (/\t/.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      const l = line.replace(/^#HttpOnly_/, '');
      if (!l || l.startsWith('#')) continue;
      const f = l.split('\t');
      if (f.length >= 7 && f[0].includes(domain)) jar[f[5]] = f[6];
    }
    return jar;
  }
  for (const part of text.replace(/^cookie:\s*/i, '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return jar;
}

export const cookieHeader = (jar: CookieJar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

export const hasYouTubeSession = (jar: CookieJar) => !!(jar.SAPISID || jar['__Secure-3PAPISID']) && !!(jar.SID || jar['__Secure-3PSID'] || jar['__Secure-1PSID']);

/** Take cookies the server set (rotation): returns true when the jar changed. */
export function absorbSetCookies(jar: CookieJar, headers: Headers): boolean {
  const list: string[] = typeof (headers as any).getSetCookie === 'function' ? (headers as any).getSetCookie() : [];
  let changed = false;
  for (const sc of list) {
    const [pair, ...attrs] = sc.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const dom = attrs.find((a) => /^\s*domain=/i.test(a))?.split('=')[1]?.trim() || '';
    if (dom && !/youtube\.com$/i.test(dom.replace(/^\./, ''))) continue;
    const expired = attrs.some((a) => /^\s*max-age=0/i.test(a)) || attrs.some((a) => /^\s*expires=/i.test(a) && Date.parse(a.split('=')[1]) < Date.now());
    if (expired || !value) continue; // never let a response log us out
    if (jar[name] !== value) {
      jar[name] = value;
      changed = true;
    }
  }
  return changed;
}

/** The Authorization header youtube.com sends for signed-in API calls. */
export function sapisidHash(jar: CookieJar, nowSec = Math.floor(Date.now() / 1000), origin = ORIGIN) {
  const h = (secret: string) => `${nowSec}_${createHash('sha1').update(`${nowSec} ${secret} ${origin}`).digest('hex')}`;
  const parts: string[] = [];
  const sapisid = jar.SAPISID || jar['__Secure-3PAPISID'];
  if (sapisid) parts.push(`SAPISIDHASH ${h(sapisid)}`);
  if (jar['__Secure-1PAPISID']) parts.push(`SAPISID1PHASH ${h(jar['__Secure-1PAPISID'])}`);
  if (jar['__Secure-3PAPISID']) parts.push(`SAPISID3PHASH ${h(jar['__Secure-3PAPISID'])}`);
  return parts.join(' ');
}

// ---------- parsing ----------

const isObj = (o: unknown): o is Record<string, any> => !!o && typeof o === 'object';

export function textOf(t: any): string {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (typeof t.simpleText === 'string') return t.simpleText;
  if (typeof t.content === 'string') return t.content;
  if (typeof t.text === 'string') return t.text;
  if (Array.isArray(t.runs)) return t.runs.map((r: any) => r.text || '').join('');
  return '';
}

function findAll(o: any, key: string, out: any[] = [], depth = 0): any[] {
  if (!isObj(o) || depth > 80) return out;
  if (key in o) out.push(o[key]);
  for (const v of Object.values(o)) if (isObj(v)) findAll(v, key, out, depth + 1);
  return out;
}

function findFirst(o: any, key: string, depth = 0): any {
  if (!isObj(o) || depth > 80) return undefined;
  if (key in o) return o[key];
  for (const v of Object.values(o)) {
    if (!isObj(v)) continue;
    const f = findFirst(v, key, depth + 1);
    if (f !== undefined) return f;
  }
  return undefined;
}

/** "1:00:06" -> 3606 */
export function clockSeconds(text: string): number | null {
  const m = /^\s*(\d+(?::\d{2}){1,2})\s*$/.exec(text || '');
  return m ? m[1].split(':').map(Number).reduce((a, n) => a * 60 + n, 0) : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "3 days ago" / "Streamed 2 weeks ago" -> ISO; vaguer ones ("1 year ago") -> null. */
export function relativeDate(text: string, now = Date.now()): string | null {
  const m = /(\d+)\s+(second|minute|hour|day|week)s?\s+ago/i.exec(text || '');
  if (!m) return null;
  const unit = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5 }[m[2].toLowerCase() as 'day'];
  return new Date(now - Number(m[1]) * unit).toISOString();
}

/** End of the day a history section stands for ("Today", "Yesterday", "Monday", "Nov 3", "Nov 3, 2025"). */
export function sectionDayEnd(label: string, now = Date.now()): number | null {
  const s = (label || '').trim().toLowerCase();
  const end = (d: Date) => {
    const e = new Date(d);
    e.setHours(23, 59, 59, 999);
    return Math.min(e.getTime(), now);
  };
  const today = new Date(now);
  if (s === 'today') return now;
  if (s === 'yesterday') return end(new Date(now - 864e5));
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const wd = days.indexOf(s);
  if (wd >= 0) {
    const back = (today.getDay() - wd + 7) % 7 || 7;
    return end(new Date(now - back * 864e5));
  }
  const m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?$/.exec(s);
  if (m && MONTHS.includes(m[1])) {
    const d = new Date(today);
    d.setMonth(MONTHS.indexOf(m[1]), Number(m[2]));
    if (m[3]) d.setFullYear(Number(m[3]));
    else if (d.getTime() > now) d.setFullYear(d.getFullYear() - 1);
    return end(d);
  }
  return null;
}

/** "Jul 28, 2026", "Premiered Jul 28, 2026", "Streamed live on 3 Nov 2025" -> ISO date. */
export function parseDateLabel(label: string): string | null {
  const s = (label || '').replace(/^(premiered|streamed live on|streamed|published on|started streaming on)\s+/i, '').trim();
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s) || null;
  const d = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/.exec(s) || null;
  let y: number, mo: number, day: number;
  if (m && MONTHS.includes(m[1].toLowerCase())) [y, mo, day] = [Number(m[3]), MONTHS.indexOf(m[1].toLowerCase()), Number(m[2])];
  else if (d && MONTHS.includes(d[2].toLowerCase())) [y, mo, day] = [Number(d[3]), MONTHS.indexOf(d[2].toLowerCase()), Number(d[1])];
  else return relativeDate(s);
  return new Date(Date.UTC(y, mo, day, 12)).toISOString();
}

const viewsOf = (s: string) => {
  const m = /([\d.,]+)\s*([KMB])?\s*views?/i.exec(s || '');
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase() as 'K'] || 1));
};

function progressOf(node: any): number | null {
  const legacy = findFirst(node, 'thumbnailOverlayResumePlaybackRenderer')?.percentDurationWatched;
  if (typeof legacy === 'number') return legacy;
  const bar = findFirst(node, 'thumbnailOverlayProgressBarViewModel');
  if (bar && typeof bar.startPercent === 'number') return bar.startPercent;
  return null;
}

function fromRenderer(r: any, now: number): YtVideo | null {
  if (!r?.videoId) return null;
  const owner = r.ownerText?.runs?.[0] || r.longBylineText?.runs?.[0] || r.shortBylineText?.runs?.[0];
  const dur = Number(r.lengthSeconds) || clockSeconds(textOf(r.lengthText)) || clockSeconds(findAll(r, 'thumbnailOverlayTimeStatusRenderer').map((x) => textOf(x.text))[0] || '');
  return {
    id: r.videoId,
    title: textOf(r.title) || textOf(r.headline),
    channel: textOf(owner) || undefined,
    channelId: owner?.navigationEndpoint?.browseEndpoint?.browseId || undefined,
    dur: dur || null,
    date: relativeDate(textOf(r.publishedTimeText), now),
    pct: progressOf(r),
    views: viewsOf(textOf(r.viewCountText)),
  };
}

function fromLockup(l: any, now: number): YtVideo | null {
  if (!l?.contentId || (l.contentType && l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO')) return null;
  const meta = l.metadata?.lockupMetadataViewModel;
  const rows: string[][] = (meta?.metadata?.contentMetadataViewModel?.metadataRows || []).map((r: any) => (r.metadataParts || []).map((p: any) => textOf(p.text)));
  const flat = rows.flat();
  const channelRun = findAll(meta, 'browseEndpoint').find((b: any) => /^UC[\w-]{22}$/.test(b?.browseId || ''));
  const badge = findAll(l, 'thumbnailBadgeViewModel').map((b: any) => b.text).find((t: string) => clockSeconds(t));
  return {
    id: l.contentId,
    title: textOf(meta?.title),
    channel: rows[0]?.[0] && !/views?$|ago$/i.test(rows[0][0]) ? rows[0][0] : undefined,
    channelId: channelRun?.browseId,
    dur: badge ? clockSeconds(badge) : null,
    date: relativeDate(flat.find((t) => /ago$/i.test(t)) || '', now),
    pct: progressOf(l),
    views: viewsOf(flat.find((t) => /views?$/i.test(t)) || ''),
  };
}

const RENDERERS = ['videoRenderer', 'compactVideoRenderer', 'gridVideoRenderer', 'playlistVideoRenderer', 'playlistPanelVideoRenderer', 'videoWithContextRenderer'];

/** Every (non-Shorts) video in an InnerTube response, in page order, without duplicates. */
export function parseVideos(json: any, now = Date.now()): YtVideo[] {
  const out: YtVideo[] = [];
  const seen = new Set<string>();
  const walk = (o: any, depth = 0) => {
    if (!isObj(o) || depth > 80) return;
    if (Array.isArray(o)) {
      for (const v of o) walk(v, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'reelShelfRenderer' || k === 'richShelfRenderer' || k === 'shortsLockupViewModel' || k === 'reelItemRenderer') continue;
      let video: YtVideo | null = null;
      if (RENDERERS.includes(k)) video = fromRenderer(v, now);
      else if (k === 'lockupViewModel') video = fromLockup(v, now);
      if (video) {
        if (!seen.has(video.id) && video.title) {
          seen.add(video.id);
          out.push(video);
        }
        continue;
      }
      if (isObj(v)) walk(v, depth + 1);
    }
  };
  walk(json);
  return out;
}

/** Watch history: videos with the day each section stands for. */
export function parseHistory(json: any, now = Date.now()): YtVideo[] {
  const out: YtVideo[] = [];
  const sections = findAll(json, 'itemSectionRenderer');
  if (!sections.length) return parseVideos(json, now);
  const seen = new Set<string>();
  for (const s of sections) {
    const label = textOf(s.header?.itemSectionHeaderRenderer?.title) || textOf(findFirst(s.header, 'title'));
    const by = sectionDayEnd(label, now);
    for (const v of parseVideos(s.contents || s, now)) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      out.push({ ...v, watchedBy: by });
    }
  }
  return out;
}

export function parsePlaylists(json: any): YtPlaylist[] {
  const out: YtPlaylist[] = [];
  const seen = new Set<string>();
  for (const l of findAll(json, 'lockupViewModel')) {
    if (!/PLAYLIST|PODCAST/.test(l?.contentType || '') || !l.contentId || seen.has(l.contentId)) continue;
    seen.add(l.contentId);
    const count = findAll(l, 'thumbnailBadgeViewModel').map((b: any) => b.text).find((t: string) => /\d/.test(t || ''));
    out.push({ id: l.contentId, title: textOf(l.metadata?.lockupMetadataViewModel?.title), count: count ? Number(count.replace(/[^\d]/g, '')) || null : null, kind: /PODCAST/.test(l.contentType) ? 'podcast' : 'playlist' });
  }
  for (const r of findAll(json, 'gridPlaylistRenderer')) {
    if (!r?.playlistId || seen.has(r.playlistId)) continue;
    seen.add(r.playlistId);
    out.push({ id: r.playlistId, title: textOf(r.title), count: Number(textOf(r.videoCountText).replace(/[^\d]/g, '')) || null, kind: 'playlist' });
  }
  return out;
}

export function continuationOf(json: any): string | null {
  for (const key of ['continuationItemRenderer', 'continuationItemViewModel']) {
    for (const c of findAll(json, key)) {
      const token = c?.continuationEndpoint?.continuationCommand?.token || findAll(c, 'continuationCommand').find((x: any) => x?.token)?.token;
      if (token) return token;
    }
  }
  const browse = findAll(json, 'continuationCommand').find((x: any) => x?.token && /BROWSE/.test(x.request || ''));
  return browse?.token || findAll(json, 'nextContinuationData')[0]?.continuation || null;
}

/** ytInitialData / ytcfg from a youtube.com page. */
export function pageData(html: string) {
  const grab = (re: RegExp) => {
    const m = re.exec(html);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  };
  const data = grab(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s) || grab(/ytInitialData"\]\s*=\s*(\{.+?\});/s);
  const cfg: Record<string, any> = {};
  for (const m of html.matchAll(/ytcfg\.set\((\{.+?\})\);/gs)) {
    try {
      Object.assign(cfg, JSON.parse(m[1]));
    } catch { /* partial */ }
  }
  return { data, cfg };
}

// ---------- client ----------

type Fetch = typeof fetch;

export class InnerTube {
  version = FALLBACK_VERSION;
  visitor: string | null = null;
  jarChanged = false;
  jar: CookieJar | null;
  private fetchImpl: Fetch;
  constructor(jar: CookieJar | null = null, fetchImpl: Fetch = fetch) {
    this.jar = jar;
    this.fetchImpl = fetchImpl;
  }

  private headers(extra: Record<string, string> = {}) {
    const h: Record<string, string> = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', origin: ORIGIN, referer: `${ORIGIN}/`, ...extra };
    if (this.jar && Object.keys(this.jar).length) {
      h.cookie = cookieHeader(this.jar);
      const auth = sapisidHash(this.jar);
      if (auth) {
        h.authorization = auth;
        h['x-origin'] = ORIGIN;
        h['x-goog-authuser'] = '0';
      }
    }
    if (this.visitor) h['x-goog-visitor-id'] = this.visitor;
    return h;
  }

  async api(endpoint: string, body: Record<string, unknown>) {
    const res = await this.fetchImpl(`${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', 'x-youtube-client-name': '1', 'x-youtube-client-version': this.version }),
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: this.version, hl: 'en', gl: 'US', ...(this.visitor ? { visitorData: this.visitor } : {}) } }, ...body }),
      signal: AbortSignal.timeout(15000),
    });
    if (this.jar && absorbSetCookies(this.jar, res.headers)) this.jarChanged = true;
    if (res.status === 401 || res.status === 403) throw new YouTubeAuthError(`YouTube refused the request (${res.status}); the sign-in may have expired`);
    if (!res.ok) throw new Error(`YouTube ${endpoint} ${res.status}`);
    return res.json();
  }

  async page(path: string) {
    const res = await this.fetchImpl(`${ORIGIN}${path}${path.includes('?') ? '&' : '?'}hl=en&persist_hl=1`, { headers: this.headers({ accept: 'text/html' }), redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (this.jar && absorbSetCookies(this.jar, res.headers)) this.jarChanged = true;
    const html = await res.text();
    const { data, cfg } = pageData(html);
    if (cfg.INNERTUBE_CLIENT_VERSION) this.version = cfg.INNERTUBE_CLIENT_VERSION;
    if (cfg.VISITOR_DATA) this.visitor = cfg.VISITOR_DATA;
    return { data, cfg, url: res.url, status: res.status };
  }

  /** "@handle", a channel URL or a UC id -> {id, title}. */
  async resolveChannel(input: string): Promise<{ id: string; title: string; image: string | null } | null> {
    const s = input.trim();
    let id = /(UC[\w-]{22})/.exec(s)?.[1] || null;
    if (!id) {
      const url = /^https?:/.test(s) ? s : `${ORIGIN}/${s.startsWith('@') ? s : `@${s}`}`;
      const r = await this.api('navigation/resolve_url', { url });
      id = r?.endpoint?.browseEndpoint?.browseId || null;
    }
    if (!id) return null;
    const ch = await this.api('browse', { browseId: id });
    const meta = ch?.metadata?.channelMetadataRenderer;
    const title = meta?.title || textOf(findFirst(ch, 'pageHeaderViewModel')?.title?.dynamicTextViewModel?.text) || '';
    const image = meta?.avatar?.thumbnails?.slice(-1)[0]?.url || null;
    return { id, title, image };
  }

  /** A channel's playlists (its series). */
  async channelPlaylists(channelId: string, maxPages = 6): Promise<YtPlaylist[]> {
    let json = await this.api('browse', { browseId: channelId, params: 'EglwbGF5bGlzdHPyBgQKAkIA' });
    const out = parsePlaylists(json);
    for (let i = 1; i < maxPages; i++) {
      const token = continuationOf(json);
      if (!token) break;
      json = await this.api('browse', { continuation: token });
      out.push(...parsePlaylists(json).filter((p) => !out.some((o) => o.id === p.id)));
    }
    return out;
  }

  /** Videos of a playlist (a channel's uploads are playlist "UU…"). */
  async playlistVideos(playlistId: string, max = 400): Promise<{ title: string; videos: YtVideo[] }> {
    let json = await this.api('browse', { browseId: `VL${playlistId}` });
    const title = textOf(findFirst(json, 'pageHeaderViewModel')?.title?.dynamicTextViewModel?.text) || findFirst(json, 'playlistMetadataRenderer')?.title || '';
    const videos = parseVideos(json);
    while (videos.length < max) {
      const token = continuationOf(json);
      if (!token) break;
      json = await this.api('browse', { continuation: token });
      const more = parseVideos(json).filter((v) => !videos.some((x) => x.id === v.id));
      if (!more.length) break;
      videos.push(...more);
    }
    return { title, videos: videos.slice(0, max) };
  }

  /** Exact publish date of a video (playlists only say "2 years ago"). */
  async videoDate(videoId: string): Promise<string | null> {
    const n = await this.api('next', { videoId });
    const label =
      textOf(findFirst(n, 'videoDescriptionHeaderRenderer')?.publishDate) ||
      textOf(findFirst(n, 'videoPrimaryInfoRenderer')?.dateText) ||
      textOf(findFirst(n, 'dateText'));
    return parseDateLabel(label);
  }

  /**
   * A video's title, length and channel, no sign-in needed. YouTube often refuses player requests from
   * servers ("confirm you're not a bot"), so a search for the id, which lists the video first, backs it up.
   */
  async videoInfo(videoId: string): Promise<{ id: string; title: string; dur: number | null; channel: string | null; channelId: string | null } | null> {
    try {
      const d = (await this.api('player', { videoId }))?.videoDetails;
      const dur = Number(d?.lengthSeconds);
      if (d?.videoId === videoId && dur > 0) return { id: videoId, title: d.title || '', dur, channel: d.author || null, channelId: d.channelId || null };
    } catch { /* try the search */ }
    const hit = (await this.search(videoId)).find((v) => v.id === videoId);
    return hit ? { id: videoId, title: hit.title, dur: hit.dur || null, channel: hit.channel || null, channelId: hit.channelId || null } : null;
  }

  async search(query: string): Promise<YtVideo[]> {
    const json = await this.api('search', { query, params: 'EgIQAQ%3D%3D' });
    return parseVideos(json);
  }

  /** Your watch history (needs the signed-in cookies). Newest first. */
  async history(maxPages = 1): Promise<YtVideo[]> {
    if (!this.jar || !hasYouTubeSession(this.jar)) throw new YouTubeAuthError('No YouTube sign-in saved');
    const { data, cfg } = await this.page('/feed/history');
    if (cfg.LOGGED_IN === false || !data) throw new YouTubeAuthError('YouTube says this sign-in is no longer valid; send Trove a fresh one');
    const videos = parseHistory(data);
    let json = data;
    for (let i = 1; i < maxPages; i++) {
      const token = continuationOf(json);
      if (!token) break;
      json = await this.api('browse', { continuation: token });
      for (const v of parseHistory(json)) if (!videos.some((x) => x.id === v.id)) videos.push(v);
    }
    return videos;
  }
}
