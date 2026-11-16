// The server sync end to end, offline: Spotify (web player API) and YouTube (watch history) answer
// like the real services, Notion and Blob are in memory. Phone plays become episodes, twins are
// paired, nothing is written twice, rotated YouTube cookies are kept, expired sign-ins are flagged.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fakeNotion } from './helpers/fake-notion.mjs';

register('./helpers/web-resolve.mjs', import.meta.url);
globalThis.__TROVE_TIME_SCALE__ = 0;
Object.assign(process.env, { NOTION_TOKEN: 'test', TROVE_LIBRARY_DS: 'lib-ds', TROVE_SESSION_SECRET: 'sync-secret', TROVE_EPISODES_DS: 'ep-ds', BLOB_READ_WRITE_TOKEN: 'fake' });

const NOW = Date.now();
const SHOW = 'S'.repeat(22);
const E1 = '1'.repeat(22);
const E2 = '2'.repeat(22);
const V1 = 'aaaaaaaaaaa';
const V2 = 'bbbbbbbbbbb';
const E4 = '4'.repeat(22);
const V4 = 'ddddddddddd';
const E5 = '5'.repeat(22);
const V5 = 'eeeeeeeeeee';
const E6 = '6'.repeat(22);
const V6 = 'fffffffffff';
const V6RE = 'rrrrrrrrrrr';
const E7 = '7'.repeat(22);
const V7 = 'ggggggggggg';
const world = { anonymous: false, played: { [E1]: [900_000, 'IN_PROGRESS'], [E2]: [0, 'COMPLETED'] }, history: { [V1]: 37, [V2]: 100 }, rotate: 'rotated-1' };
const seen = [];

const episode = (id, name, ms, released) => ({
  entity: { data: { __typename: 'Episode', id, uri: `spotify:episode:${id}`, name, duration: { totalMilliseconds: ms }, releaseDate: { isoString: released }, mediaTypes: ['AUDIO'], podcastV2: { data: { name: 'Test Show Podcast', uri: `spotify:show:${SHOW}` } }, playedState: world.played[id] ? { playPositionMilliseconds: world.played[id][0], state: world.played[id][1] } : { playPositionMilliseconds: 0, state: 'NOT_STARTED' } } },
});
const lockup = (id, title, len, pct) => ({ lockupViewModel: { contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { progressBar: { thumbnailOverlayProgressBarViewModel: { startPercent: pct } }, badges: [{ thumbnailBadgeViewModel: { text: len } }] } }] } }, metadata: { lockupMetadataViewModel: { title: { content: title }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: 'Test Show' } }] }] } } } } } });

let N;
let notionFetch;
async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const json = (d, status = 200, headers = {}) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json', ...headers } });
  seen.push(`${url.hostname}${url.pathname}`);
  if (url.hostname === 'api.notion.com') {
    if (world.notionDown && /^\/v1\/pages/.test(url.pathname) && init.method && init.method !== 'GET') return json({ object: 'error', code: 'validation_error', message: 'down' }, 400);
    return notionFetch(input, init);
  }
  if (url.hostname === 'raw.githubusercontent.com') return json({}, 404);
  if (url.hostname === 'open.spotify.com' && url.pathname === '/api/server-time') return json({ serverTime: Math.floor(Date.now() / 1000) });
  if (url.hostname === 'open.spotify.com' && url.pathname === '/api/token') {
    assert.match(init.headers.cookie || '', /sp_dc=/);
    assert.match(url.search, /totp=\d{6}&totpServer=\d{6}&totpVer=61/);
    return json({ accessToken: 'web-token', accessTokenExpirationTimestampMs: Date.now() + 3600e3, isAnonymous: world.anonymous, clientId: 'x' });
  }
  if (url.hostname === 'api-partner.spotify.com') {
    const body = JSON.parse(init.body);
    if (body.operationName === 'profileAttributes') return json({ data: { me: { profile: { username: 'user1', name: 'Mario' } } } });
    if (body.operationName === 'libraryV3') return json({ data: { me: { libraryV3: { __typename: 'LibraryPage', items: [] } } } });
    if (body.operationName === 'queryPodcastEpisodes')
      return json({ data: { podcastUnionV2: { __typename: 'Podcast', name: 'Test Show Podcast', episodesV2: { totalCount: 3, items: [episode(E1, 'Ep A: The Future of Agents', 3_606_000, '2026-11-10T10:00:00Z'), episode(E2, 'Ep B: Pricing', 1_800_000, '2026-11-03T10:00:00Z'), episode('3'.repeat(22), 'Ep C', 1_200_000, '2026-10-27T10:00:00Z'), ...(world.extraEpisodes || []).map((e) => episode(...e))] } } } });
    if (body.operationName === 'getEpisodeOrChapter') return json({ data: { episodeUnionV2: null } });
    return json({ errors: [{ message: `unknown op ${body.operationName}` }] }, 400);
  }
  if (url.hostname === 'spclient.wg.spotify.com') return json({ playContexts: [{ uri: `spotify:show:${SHOW}`, lastPlayedTime: world.lastPlayed || NOW - 60_000 }] });
  if (url.hostname === 'www.youtube.com' && url.pathname === '/feed/history') {
    const data = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { header: { itemSectionHeaderRenderer: { title: { simpleText: 'Today' } } }, contents: [lockup(V1, 'Ep A: The Future of Agents', '1:00:06', world.history[V1]), lockup(V2, 'Something else entirely', '12:00', world.history[V2]), ...(world.extraHistory || []).map((v) => lockup(...v))] } }] } } } }] } } };
    const html = `<html><script>ytcfg.set({"INNERTUBE_CLIENT_VERSION":"2.20261101.00.00","LOGGED_IN":true,"VISITOR_DATA":"v1"});</script><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`;
    const headers = new Headers({ 'content-type': 'text/html' });
    headers.append('set-cookie', `__Secure-1PSIDTS=${world.rotate}; Domain=.youtube.com; Path=/; Secure`);
    return new Response(html, { status: 200, headers });
  }
  if (url.hostname === 'www.youtube.com' && url.pathname.startsWith('/youtubei/v1/search')) {
    const q = JSON.parse(init.body).query;
    const video = (id, title, len, channel = 'Test Show') => ({ videoRenderer: { videoId: id, title: { runs: [{ text: title }] }, lengthText: { simpleText: len }, ownerText: { runs: [{ text: channel, navigationEndpoint: { browseEndpoint: { browseId: 'UC' + channel.replace(/\W/g, 'x').padEnd(22, 'x').slice(0, 22) } } }] } } });
    const hits = /Ep A/.test(q) ? [video(V1, 'Ep A: The Future of Agents', '1:00:06')]
      : /Ep D/.test(q) ? [video(V4, 'Ep D: Robots at Home', '25:00')]
        : /Ep F/.test(q) ? [video(V6RE, 'Ep F: Deep Sea', '30:00', 'Random Reuploads'), video(V6, 'Ep F: Deep Sea | Test Show', '28:50')]
          : [];
    return json({ contents: { items: hits } });
  }
  if (url.hostname === 'www.youtube.com' && url.pathname.startsWith('/youtubei/v1/player')) {
    const id = JSON.parse(init.body).videoId;
    return json(id === V7 ? { playabilityStatus: { status: 'UNPLAYABLE' }, videoDetails: { videoId: V7, title: 'Ep G: Volcanoes', lengthSeconds: '1500', author: 'Test Show', channelId: 'UCxx' } } : {});
  }
  if (url.hostname === 'www.youtube.com') return json({});
  throw new Error(`unexpected fetch ${url}`);
}

let M;
let E;
let V;
before(async () => {
  const { episodesSchema } = await import('../web/lib/episodes.ts');
  N = fakeNotion(episodesSchema());
  notionFetch = N.fetch;
  globalThis.fetch = fakeFetch;
  M = await import('../web/lib/media-sync.ts');
  E = await import('../web/lib/episodes.ts');
  V = await import('../web/lib/vault.ts');
});

test('connecting checks the sign-ins and keeps them encrypted', async () => {
  await assert.rejects(M.connectSpotify('nope'), /sp_dc/);
  const me = await M.connectSpotify(`sp_dc=${'A'.repeat(60)}; Path=/`);
  assert.equal(me.username, 'user1');
  const stored = [...globalThis.__fakeBlob.entries()].find(([k]) => k === 'state/vault/spotify.json')[1];
  assert.ok(!stored.includes('A'.repeat(60)), 'not stored in clear');
  assert.equal((await V.readSecret('spotify')).spDc, 'A'.repeat(60));
  await assert.rejects(M.connectYouTube('PREF=f6=1'), /SAPISID/);
  const yt = await M.connectYouTube('# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSAPISID\tsap/1\n.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tsid1');
  assert.equal(yt.videos, 2);
  const s = await M.syncStatus();
  assert.equal(s.spotify.connected, true);
  assert.equal(s.spotify.user, 'Mario');
  assert.equal(s.youtube.connected, true);
});

test('a sync turns phone plays into episodes and pairs the same episode across platforms', async () => {
  const r = await M.syncAll({ deadline: Date.now() + 60_000 });
  assert.equal(r.spotify.events, 2, 'in progress + finished; never-started episodes are skipped');
  assert.equal(r.youtube.events, 2);
  assert.equal(r.paired, 1);
  const found = await E.lookupRefs([`sp:${E1}`, `yt:${V1}`, `sp:${E2}`, `yt:${V2}`]);
  const a = found[`sp:${E1}`];
  assert.equal(a.id, found[`yt:${V1}`].id, 'Ep A on Spotify and on YouTube are one episode');
  assert.equal(a.status, 'started');
  assert.equal(found[`sp:${E2}`].status, 'finished');
  assert.equal(found[`sp:${E2}`].doneOn, 'sp');
  assert.equal(found[`yt:${V2}`].status, 'finished', 'YouTube says 100%');
  assert.equal(N.live().length, 3);
  // Rotated YouTube cookies were kept for next time.
  assert.equal((await V.readSecret('youtube')).jar['__Secure-1PSIDTS'], 'rotated-1');
});

test('the next sync writes nothing when nothing changed, and only the change when something did', async () => {
  const writes = () => N.calls.create + N.calls.update;
  const before = writes();
  const r = await M.syncAll({ deadline: Date.now() + 60_000 });
  assert.equal(r.spotify.events, 0);
  assert.equal(r.youtube.events, 0);
  assert.equal(writes(), before);
  world.played[E1] = [2_400_000, 'IN_PROGRESS'];
  world.lastPlayed = Date.now();
  const r2 = await M.syncAll({ deadline: Date.now() + 60_000 });
  assert.equal(r2.spotify.events, 1);
  const a = (await E.lookupRefs([`sp:${E1}`]))[`sp:${E1}`];
  assert.equal(a.resume.p, 'sp');
  assert.equal(a.resume.pos, 2400);
});

test('a change that could not be stored is read again on the next sync', async () => {
  world.played[E1] = [3_000_000, 'IN_PROGRESS'];
  world.lastPlayed = Date.now();
  world.notionDown = true;
  const r1 = await M.syncAll({ deadline: Date.now() + 60_000 });
  assert.match(r1.error, /Notion/);
  world.notionDown = false;
  const r2 = await M.syncAll({ deadline: Date.now() + 60_000 });
  assert.equal(r2.spotify.events, 1, 'not forgotten');
  assert.equal((await E.lookupRefs([`sp:${E1}`]))[`sp:${E1}`].resume.pos, 3000);
});

test('episodes a rushed sync could not pair wait in a queue and are paired on the next run', async () => {
  world.extraEpisodes = [[E4, 'Ep D: Robots at Home', 1_500_000, '2026-11-12T10:00:00Z']];
  world.played[E4] = [300_000, 'IN_PROGRESS'];
  world.extraHistory = [[V4, 'Ep D: Robots at Home', '25:00', 20]];
  world.lastPlayed = Date.now();
  // Too close to the deadline for lookups: both plays are saved, the twin search waits.
  const r1 = await M.syncAll({ deadline: Date.now() + 15_000 });
  assert.equal(r1.spotify.events, 1);
  assert.equal(r1.youtube.events, 1);
  assert.equal(r1.paired, undefined);
  assert.equal(r1.toPair, 2);
  let f = await E.lookupRefs([`sp:${E4}`, `yt:${V4}`]);
  assert.notEqual(f[`sp:${E4}`].id, f[`yt:${V4}`].id);
  // Nothing new to read next time, but the queue is worked through.
  const r2 = await M.syncAll({ deadline: Date.now() + 60_000 });
  assert.equal(r2.spotify.events, 0);
  assert.ok(r2.paired >= 1);
  assert.equal(r2.toPair, undefined, 'queue drained');
  f = await E.lookupRefs([`sp:${E4}`, `yt:${V4}`]);
  assert.equal(f[`sp:${E4}`].id, f[`yt:${V4}`].id, 'one episode on both platforms');
  assert.equal(f[`sp:${E4}`].resume.pos, 300);
});

test("the twin search prefers the show's own channel, and finds videos in shows you listen to", async () => {
  // E6 was heard on Spotify; YouTube has an exact-length re-upload first and the show's own upload,
  // 4% shorter without the ad reads, second.
  world.extraEpisodes.push([E6, 'Ep F: Deep Sea', 1_800_000, '2026-11-13T10:00:00Z'], [E5, 'Ep E: Oceans', 1_200_000, '2026-11-14T10:00:00Z']);
  world.played[E6] = [600_000, 'IN_PROGRESS'];
  // V5 was watched on YouTube only; its Spotify episode E5 was never played.
  world.extraHistory.push([V5, 'Ep E: Oceans', '20:00', 40]);
  world.lastPlayed = Date.now();
  const r = await M.syncAll({ deadline: Date.now() + 60_000 });
  assert.equal(r.paired, 2);
  const f = await E.lookupRefs([`sp:${E6}`, `yt:${V6}`, `yt:${V6RE}`, `yt:${V5}`, `sp:${E5}`]);
  assert.equal(f[`sp:${E6}`].yt.id, V6, 'the official upload, not the re-upload');
  assert.equal(f[`sp:${E6}`].yt.dur, 1730, 'its length comes along, to map positions across');
  assert.equal(f[`yt:${V6RE}`], null);
  assert.equal(f[`yt:${V5}`].id, f[`sp:${E5}`].id, 'found in the Spotify show named like its channel');
  assert.equal(f[`yt:${V5}`].resume.p, 'yt');
});

test('a copy paired without its length gets it on the next sync, so positions map across', async () => {
  // Paired by hand or by an older catalog: Trove knows the video's id but not its length.
  await E.applyEvents([{ p: 'sp', id: E7, at: Date.now(), title: 'Ep G: Volcanoes', dur: 1600, ext: { pos: 800 }, src: 'spotify', twin: { p: 'yt', id: V7, by: 'manual' } }]);
  assert.equal((await E.lookupRefs([`yt:${V7}`]))[`yt:${V7}`].yt.dur, null);
  // A day after the last check for missing lengths.
  const state = JSON.parse(globalThis.__fakeBlob.get('state/media-sync.json'));
  state.lengthScan = Date.now() - 25 * 3600e3;
  globalThis.__fakeBlob.set('state/media-sync.json', JSON.stringify(state));
  const r = await M.syncAll({ deadline: Date.now() + 120_000 });
  assert.ok(r.lengths >= 1);
  const c = (await E.lookupRefs([`yt:${V7}`]))[`yt:${V7}`];
  assert.equal(c.yt.dur, 1500);
  assert.equal(c.sp.dur, 1600);
  const again = await M.syncAll({ deadline: Date.now() + 60_000 });
  assert.equal(again.lengths, undefined, 'nothing left to look up');
});

test('an expired Spotify sign-in is reported, and YouTube keeps syncing', async () => {
  world.anonymous = true;
  world.history[V1] = 80;
  // A new token is requested once the cached one expires; force that by asking with a new cookie value.
  await V.writeSecret('spotify', { spDc: 'B'.repeat(60), user: 'user1', savedAt: Date.now() });
  const r = await M.syncAll({ deadline: Date.now() + 60_000 });
  assert.match(r.spotify.error, /sign-in/);
  assert.equal(r.youtube.events, 1);
  const s = await M.syncStatus();
  assert.equal(s.spotify.needsSignIn, true);
  assert.equal(s.youtube.needsSignIn, false);
});
