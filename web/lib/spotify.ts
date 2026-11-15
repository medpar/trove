// Spotify through the private API its web player (open.spotify.com) uses, signed in with your own
// session cookie (sp_dc). Works with free accounts, unlike the official Web API (Premium-only for
// personal apps since 2026). Each episode carries your played state: position and whether it's
// done, kept in sync by Spotify across your iPhone, iPad, Mac and the web.
// No server-only import: TOTP and the parsers are unit-tested.
import { createHmac } from 'node:crypto';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const WEB = 'https://open.spotify.com';
const PATHFINDER = 'https://api-partner.spotify.com/pathfinder/v2/query';
const SPCLIENT = 'https://spclient.wg.spotify.com';

export class SpotifyAuthError extends Error {
  code = 'spotify_auth';
}

// The web player signs its token request with a TOTP whose secret ships in its code and changes
// every few months. Version 61 is current (Nov 2026); newer ones are read from the list the
// community keeps (also used by spotify-webplayer-token and spotify-tokener) when 61 stops working.
const SECRETS: Record<string, number[]> = {
  '61': [44, 55, 47, 42, 70, 40, 34, 114, 76, 74, 50, 111, 120, 97, 75, 76, 94, 102, 43, 69, 49, 120, 118, 80, 64, 78],
};
const SECRETS_URL = 'https://raw.githubusercontent.com/xyloflake/spot-secrets-go/main/secrets/secretDict.json';

/** Six-digit TOTP (SHA-1, 30 s) the way the web player computes it from a secret version. */
export function totp(secret: number[], timeSec: number): string {
  const key = Buffer.from(secret.map((c, i) => c ^ ((i % 33) + 9)).join(''), 'ascii');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeSec / 30)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000;
  return String(code).padStart(6, '0');
}

// Persisted GraphQL queries the web player sends (operation -> hash). Read again from the player's
// bundle whenever Spotify answers that a hash is unknown.
export const KNOWN_HASHES: Record<string, string> = {
  queryPodcastEpisodes: '3539d746cf882f3909660de40b4ef472b3f5893a0761d617c282541de5d412c5',
  getEpisodeOrChapter: '5f77db47e5a2ce6680330bb61317aa09e17ddd1d189513cb218e7cd3e43288be',
  libraryV3: '390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455',
  profileAttributes: '08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0',
  queryShowMetadataV2: 'b475447846f37cc426add800b995a7859c169c53c72b62de6338c0c40a5dacea',
};

/** Operation hashes in a web-player bundle: ("name","query","<sha256>"). */
export function extractHashes(js: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of js.matchAll(/"([A-Za-z][A-Za-z0-9]*)","(?:query|mutation)","([a-f0-9]{64})"/g)) out[m[1]] = m[2];
  return out;
}

export type SpEpisode = {
  id: string;
  title: string;
  dur: number | null;
  released: string | null;
  image: string | null;
  show: string | null;
  showId: string | null;
  description: string;
  video: boolean;
  /** Your played state; null when the request wasn't signed in. */
  played: { pos: number; state: string; done: boolean } | null;
};

const idOf = (uri: string | undefined) => (uri || '').split(':').pop() || '';
const bestImage = (sources: any[] | undefined, want = 300) =>
  [...(sources || [])].sort((a, b) => Math.abs((a.width || 0) - want) - Math.abs((b.width || 0) - want))[0]?.url || null;

export function parseEpisode(d: any): SpEpisode | null {
  if (!d || (d.__typename && d.__typename !== 'Episode')) return null;
  const id = d.id || idOf(d.uri);
  if (!id) return null;
  const ps = d.playedState;
  const state = String(ps?.state || '');
  return {
    id,
    title: String(d.name || '').trim(),
    dur: d.duration?.totalMilliseconds ? Math.round(d.duration.totalMilliseconds / 1000) : null,
    released: d.releaseDate?.isoString || null,
    image: bestImage(d.coverArt?.sources) || bestImage(d.podcastV2?.data?.coverArt?.sources),
    show: d.podcastV2?.data?.name || null,
    showId: idOf(d.podcastV2?.data?.uri) || null,
    description: String(d.description || '').slice(0, 600),
    video: (d.mediaTypes || []).includes('VIDEO'),
    played: ps ? { pos: Math.round((ps.playPositionMilliseconds || 0) / 1000), state, done: /COMPLETED|PLAYED|FINISHED/i.test(state) } : null,
  };
}

type Fetch = typeof fetch;
type Cached = { value: string; exp: number; anonymous: boolean };

const tokens = new Map<string, Cached>();
let remoteSecrets: { at: number; list: [string, number[]][] } | null = null;
let bundleHashes: { at: number; map: Record<string, string> } | null = null;

export class SpotifyWeb {
  hashes: Record<string, string>;
  hashesChanged = false;
  private spDc: string | null;
  private fetchImpl: Fetch;

  constructor({ spDc = null, hashes, fetchImpl = fetch }: { spDc?: string | null; hashes?: Record<string, string> | null; fetchImpl?: Fetch } = {}) {
    this.spDc = spDc?.trim() || null;
    this.hashes = { ...KNOWN_HASHES, ...(bundleHashes?.map || {}), ...(hashes || {}) };
    this.fetchImpl = fetchImpl;
  }

  private async secretList(): Promise<[string, number[]][]> {
    const local = Object.entries(SECRETS).sort((a, b) => Number(b[0]) - Number(a[0]));
    if (remoteSecrets && Date.now() - remoteSecrets.at < 6 * 3600e3) return [...remoteSecrets.list, ...local];
    try {
      const res = await this.fetchImpl(SECRETS_URL, { signal: AbortSignal.timeout(6000) });
      const dict = (await res.json()) as Record<string, number[]>;
      const list = Object.entries(dict).filter(([, v]) => Array.isArray(v)).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 3);
      remoteSecrets = { at: Date.now(), list };
      return [...list, ...local.filter(([v]) => !list.some(([r]) => r === v))];
    } catch {
      return local;
    }
  }

  /** A web-player access token (signed in when sp_dc is set). */
  async accessToken(force = false): Promise<string> {
    const key = this.spDc || 'anonymous';
    const hit = tokens.get(key);
    if (!force && hit && hit.exp - 60_000 > Date.now()) return hit.value;
    const headers: Record<string, string> = { 'user-agent': UA, accept: 'application/json', referer: `${WEB}/`, 'app-platform': 'WebPlayer' };
    if (this.spDc) headers.cookie = `sp_dc=${this.spDc}`;
    let serverTime = Math.floor(Date.now() / 1000);
    try {
      const st = await this.fetchImpl(`${WEB}/api/server-time`, { headers, signal: AbortSignal.timeout(6000) }).then((r) => r.json());
      if (Number(st?.serverTime) > 0) serverTime = Number(st.serverTime);
    } catch { /* local clock */ }
    let lastError = '';
    const tried = new Set<string>();
    const attempt = async (version: string, secret: number[]) => {
      tried.add(version);
      const now = Math.floor(Date.now() / 1000);
      const url = `${WEB}/api/token?reason=init&productType=web-player&totp=${totp(secret, now)}&totpServer=${totp(secret, serverTime)}&totpVer=${version}`;
      const res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(10000) });
      const body: any = await res.json().catch(() => ({}));
      if (res.ok && body.accessToken) {
        if (this.spDc && body.isAnonymous) throw new SpotifyAuthError('Spotify no longer accepts this sign-in (sp_dc expired or signed out); send Trove a fresh one');
        const value: Cached = { value: body.accessToken, exp: Number(body.accessTokenExpirationTimestampMs) || Date.now() + 30 * 60e3, anonymous: !!body.isAnonymous };
        tokens.set(key, value);
        return value.value;
      }
      lastError = `${res.status} ${body?.error?.message || body?.message || ''}`.trim();
      if (res.status === 401 && this.spDc) throw new SpotifyAuthError(`Spotify rejected the sign-in (${lastError})`);
      return null;
    };
    // The secret built in first; the community's newer ones only when Spotify has moved on.
    for (const [version, secret] of Object.entries(SECRETS).sort((a, b) => Number(b[0]) - Number(a[0]))) {
      const t = await attempt(version, secret);
      if (t) return t;
    }
    for (const [version, secret] of await this.secretList()) {
      if (tried.has(version)) continue;
      const t = await attempt(version, secret);
      if (t) return t;
    }
    throw new Error(`Spotify token request failed (${lastError || 'no secret worked'})`);
  }

  /** Re-read operation hashes from the web player's bundle. */
  async refreshHashes(): Promise<Record<string, string>> {
    if (bundleHashes && Date.now() - bundleHashes.at < 10 * 60e3) return (this.hashes = { ...this.hashes, ...bundleHashes.map });
    const html = await this.fetchImpl(`${WEB}/`, { headers: { 'user-agent': UA } }).then((r) => r.text());
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+web-player[^"]*\.js)"/g)].map((m) => new URL(m[1], WEB).href);
    const map: Record<string, string> = {};
    for (const src of scripts) {
      const js = await this.fetchImpl(src, { headers: { 'user-agent': UA } }).then((r) => r.text());
      Object.assign(map, extractHashes(js));
    }
    if (Object.keys(map).length) {
      bundleHashes = { at: Date.now(), map };
      const before = JSON.stringify(this.hashes);
      this.hashes = { ...this.hashes, ...map };
      this.hashesChanged ||= before !== JSON.stringify(this.hashes);
    }
    return this.hashes;
  }

  private async headers() {
    return { authorization: `Bearer ${await this.accessToken()}`, 'app-platform': 'WebPlayer', accept: 'application/json', 'content-type': 'application/json;charset=UTF-8', 'user-agent': UA, origin: WEB, referer: `${WEB}/` };
  }

  /** Run a persisted GraphQL operation (re-learning its hash once if Spotify doesn't know it). */
  async query(op: string, variables: Record<string, unknown>, retried = false): Promise<any> {
    if (!this.hashes[op]) await this.refreshHashes();
    const hash = this.hashes[op];
    if (!hash) throw new Error(`Spotify operation ${op} not found in the web player`);
    const res = await this.fetchImpl(PATHFINDER, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ variables, operationName: op, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
      signal: AbortSignal.timeout(15000),
    });
    const body: any = await res.json().catch(() => ({}));
    const msg = JSON.stringify(body?.errors || '');
    if (!retried && (/PersistedQueryNotFound|persisted query/i.test(msg) || res.status === 412)) {
      await this.refreshHashes();
      return this.query(op, variables, true);
    }
    if (res.status === 401 && !retried) {
      await this.accessToken(true);
      return this.query(op, variables, true);
    }
    if (res.status === 429) throw Object.assign(new Error('Spotify rate limit; try again later'), { status: 429 });
    if (!res.ok && !body?.data) throw new Error(`Spotify ${op} ${res.status} ${msg.slice(0, 200)}`);
    return body;
  }

  async profile(): Promise<{ username: string; name: string } | null> {
    const r = await this.query('profileAttributes', {});
    const p = r?.data?.me?.profile;
    return p?.username ? { username: p.username, name: p.name || p.username } : null;
  }

  /** What you played recently on any device: shows, episodes, playlists… with when. */
  async recentlyPlayed(username: string, limit = 50): Promise<{ uri: string; at: number }[]> {
    const url = `${SPCLIENT}/recently-played/v3/user/${encodeURIComponent(username)}/recently-played?format=json&offset=0&limit=${limit}&filter=default,collection-new-episodes&market=from_token`;
    const res = await this.fetchImpl(url, { headers: await this.headers(), signal: AbortSignal.timeout(15000) });
    if (res.status === 401) throw new SpotifyAuthError('Spotify rejected the sign-in');
    if (!res.ok) throw new Error(`Spotify recently played ${res.status}`);
    const body: any = await res.json();
    return (body.playContexts || body.items || []).map((c: any) => ({ uri: c.uri || c.context?.uri, at: Number(c.lastPlayedTime || c.timestamp || 0) })).filter((c: any) => c.uri);
  }

  /** Shows you follow (Your Library → Podcasts). */
  async libraryShows(max = 200): Promise<{ id: string; title: string; image: string | null }[]> {
    const out: { id: string; title: string; image: string | null }[] = [];
    for (const filters of [['Podcasts'], []]) {
      try {
        for (let offset = 0; offset < max; offset += 50) {
          const r = await this.query('libraryV3', { filters, order: null, textFilter: '', features: ['LIKED_SONGS', 'YOUR_EPISODES_V2', 'PRERELEASES', 'PRERELEASES_V2', 'EVENTS'], limit: 50, offset, flatten: false, expandedFolders: [], folderUri: null, includeFoldersWhenFlattening: true });
          const lib = r?.data?.me?.libraryV3;
          if (!lib || lib.__typename?.endsWith('Error')) throw new Error(lib?.__typename || 'library error');
          const items = lib.items || [];
          for (const it of items) {
            const d = it?.item?.data;
            if (d?.__typename === 'Podcast' && d.uri) out.push({ id: idOf(d.uri), title: d.name || '', image: bestImage(d.coverArt?.sources) });
          }
          if (items.length < 50) break;
        }
        return out;
      } catch {
        out.length = 0;
      }
    }
    return out;
  }

  /** One page of a show's episodes, newest first, with your played state when signed in. */
  async showEpisodes(showId: string, offset = 0, limit = 50): Promise<{ title: string; total: number; episodes: SpEpisode[] }> {
    const r = await this.query('queryPodcastEpisodes', { uri: `spotify:show:${showId}`, offset, limit, includeEpisodeContentRatingsV2: false });
    const pod = r?.data?.podcastUnionV2;
    if (!pod) throw new Error(`Spotify show ${showId} not found`);
    const page = pod.episodesV2 || {};
    const episodes = (page.items || []).map((i: any) => parseEpisode(i?.entity?.data)).filter(Boolean) as SpEpisode[];
    return { title: pod.name || '', total: Number(page.totalCount) || episodes.length, episodes: episodes.map((e) => ({ ...e, show: e.show || pod.name || null, showId: e.showId || showId })) };
  }

  /** Every episode of a show (up to max). */
  async allEpisodes(showId: string, max = 1000) {
    const first = await this.showEpisodes(showId, 0, 50);
    const episodes = [...first.episodes];
    for (let offset = 50; offset < Math.min(first.total, max); offset += 50) episodes.push(...(await this.showEpisodes(showId, offset, 50)).episodes);
    return { title: first.title, total: first.total, episodes };
  }

  async episode(id: string): Promise<SpEpisode | null> {
    const r = await this.query('getEpisodeOrChapter', { uri: `spotify:episode:${id}`, includeEpisodeContentRatingsV2: false });
    return parseEpisode(r?.data?.episodeUnionV2);
  }

  /** Show name, cover and publisher. */
  async show(showId: string): Promise<{ id: string; title: string; image: string | null; publisher: string | null } | null> {
    try {
      const r = await this.query('queryShowMetadataV2', { uri: `spotify:show:${showId}` });
      const p = r?.data?.podcastUnionV2;
      if (p?.name) return { id: showId, title: p.name, image: bestImage(p.coverArt?.sources, 640), publisher: p.publisher?.name || null };
    } catch { /* fall back to the episodes query */ }
    const page = await this.showEpisodes(showId, 0, 1);
    return { id: showId, title: page.title, image: page.episodes[0]?.image || null, publisher: null };
  }
}
