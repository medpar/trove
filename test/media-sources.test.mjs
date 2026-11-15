// Reading YouTube (InnerTube) and Spotify (web player API): parsers on real responses, history,
// cookies and the token signature. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  absorbSetCookies, continuationOf, hasYouTubeSession, parseCookies, parseDateLabel, parseHistory, parsePlaylists, parseVideos, relativeDate, sapisidHash, sectionDayEnd,
} from '../web/lib/innertube.ts';
import { extractHashes, parseEpisode, totp } from '../web/lib/spotify.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures-youtube.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-15T21:00:00Z');

test('YouTube playlist pages (2025+ lockups): ids, lengths, channel, dates, next page', () => {
  const v = parseVideos(fx.playlist, NOW);
  assert.deepEqual(v.map((x) => x.id), ['y1-9yeYLJUo', 'vl7HiMdGfjo', 'yslXlV2BP_Y']);
  assert.equal(v[0].title, 'The Rise Of AI Coworkers');
  assert.equal(v[0].dur, 3606);
  assert.equal(v[0].channel, 'Y Combinator');
  assert.equal(v[0].views, 58000);
  assert.equal(v[1].date.slice(0, 10), '2026-11-01', '"2 weeks ago"');
  assert.equal(v[2].date, null, '"1 month ago" is too vague to match on');
  assert.ok(continuationOf(fx.playlist));
});

test('YouTube channel playlists and search results', () => {
  const lists = parsePlaylists(fx.playlists);
  assert.deepEqual(lists.map((p) => [p.title, p.count, p.kind]), [['Built to a Billion', 1, 'playlist'], ['W27 RFS', 11, 'playlist'], ['Startup School 2026', 15, 'playlist'], ['Lightcone Podcast', 56, 'podcast']]);
  const hits = parseVideos(fx.search, NOW);
  assert.equal(hits[0].id, 'Q78dJ0vkWe8');
  assert.equal(hits[0].dur, 2655);
  assert.equal(hits[0].channelId, 'UCcefcZRL2oaA_uBNeo5UOWg');
  assert.equal(hits[0].channel, 'Y Combinator');
});

const lockup = (id, title, len, pct) => ({
  lockupViewModel: {
    contentId: id,
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { progressBar: { thumbnailOverlayProgressBarViewModel: { startPercent: pct } }, badges: [{ thumbnailBadgeViewModel: { text: len } }] } }] } },
    metadata: { lockupMetadataViewModel: { title: { content: title }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: 'Y Combinator' } }] }, { metadataParts: [{ text: { content: '1.2M views' } }] }] } } } },
  },
});
const legacy = (id, title, len, pct) => ({
  videoRenderer: { videoId: id, title: { runs: [{ text: title }] }, lengthText: { simpleText: len }, ownerText: { runs: [{ text: 'Lex Fridman', navigationEndpoint: { browseEndpoint: { browseId: 'UCSHZKyawb77ixDdsGog4iWA' } } }] }, thumbnailOverlays: [{ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: pct } }] },
});
const section = (label, items) => ({ itemSectionRenderer: { header: { itemSectionHeaderRenderer: { title: { simpleText: label } } }, contents: items } });

test('watch history: what you watched (phone included), how much, and which day', () => {
  const page = {
    contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
      section('Today', [lockup('aaaaaaaaaaa', 'Lightcone: AI agents', '1:00:06', 37), { reelShelfRenderer: { items: [{ shortsLockupViewModel: { entityId: 'shorts-x' } }] } }]),
      section('Yesterday', [legacy('bbbbbbbbbbb', 'Lex Fridman #450', '3:01:10', 100)]),
      section('Nov 3', [lockup('ccccccccccc', 'Design Review', '21:40', 12), lockup('aaaaaaaaaaa', 'dup', '1:00:06', 37)]),
    ] } } } }] } },
  };
  const h = parseHistory(page, NOW);
  assert.deepEqual(h.map((v) => [v.id, v.pct, v.dur]), [['aaaaaaaaaaa', 37, 3606], ['bbbbbbbbbbb', 100, 10870], ['ccccccccccc', 12, 1300]]);
  assert.equal(h[0].watchedBy, NOW);
  assert.equal(new Date(h[1].watchedBy).getDate(), new Date(NOW - 864e5).getDate());
  assert.equal(new Date(h[2].watchedBy).getMonth(), 10);
  assert.equal(new Date(h[2].watchedBy).getDate(), 3);
  assert.equal(h[1].channelId, 'UCSHZKyawb77ixDdsGog4iWA');
});

test('dates YouTube writes', () => {
  assert.equal(parseDateLabel('Jul 28, 2026'), '2026-07-28T12:00:00.000Z');
  assert.equal(parseDateLabel('Premiered Mar 6, 2026'), '2026-03-06T12:00:00.000Z');
  assert.equal(parseDateLabel('Streamed live on 3 Nov 2025'), '2025-11-03T12:00:00.000Z');
  assert.equal(relativeDate('3 days ago', NOW), new Date(NOW - 3 * 864e5).toISOString());
  assert.equal(relativeDate('2 years ago', NOW), null);
  const monday = sectionDayEnd('Monday', NOW);
  assert.equal(new Date(monday).getDay(), 1);
  assert.ok(monday < NOW);
  assert.ok(sectionDayEnd('Dec 30', NOW) < NOW, 'a date later in the year means last year');
});

test('YouTube sign-in cookies: any export format, the auth header, rotation', () => {
  const netscape = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSAPISID\tabc/def\n.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tsid1\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\t__Secure-3PSID\tps3\n.google.com\tTRUE\t/\tTRUE\t1893456000\tNID\tother';
  const a = parseCookies(netscape);
  assert.deepEqual(a, { SAPISID: 'abc/def', SID: 'sid1', '__Secure-3PSID': 'ps3' });
  assert.ok(hasYouTubeSession(a));
  assert.deepEqual(parseCookies('Cookie: SAPISID=x; SID=y'), { SAPISID: 'x', SID: 'y' });
  assert.deepEqual(parseCookies(JSON.stringify([{ name: 'SAPISID', value: 'j', domain: '.youtube.com' }, { name: 'X', value: 'n', domain: '.example.com' }])), { SAPISID: 'j' });
  assert.equal(hasYouTubeSession({ PREF: 'x' }), false);
  const h = sapisidHash({ SAPISID: 'abc/def', '__Secure-3PAPISID': 'abc/def' }, 1700000000);
  assert.match(h, /^SAPISIDHASH 1700000000_[0-9a-f]{40} SAPISID3PHASH 1700000000_[0-9a-f]{40}$/);
  const jar = { SAPISID: 'a', '__Secure-1PSIDTS': 'old' };
  const headers = { getSetCookie: () => ['__Secure-1PSIDTS=new; Domain=.youtube.com; Path=/; Secure', 'SID=; Max-Age=0; Domain=.youtube.com', 'NID=1; Domain=.google.com'] };
  assert.equal(absorbSetCookies(jar, headers), true);
  assert.deepEqual(jar, { SAPISID: 'a', '__Secure-1PSIDTS': 'new' }, 'rotated, never logged out, nothing from other domains');
});

test('Spotify: token signature, operation hashes, your played state', () => {
  const secret = [44, 55, 47, 42, 70, 40, 34, 114, 76, 74, 50, 111, 120, 97, 75, 76, 94, 102, 43, 69, 49, 120, 118, 80, 64, 78];
  const a = totp(secret, 1794774153);
  assert.match(a, /^\d{6}$/);
  assert.equal(totp(secret, 1794774153 + 5), a, 'same 30-second window');
  assert.notEqual(totp(secret, 1794774153 + 60), a);
  const js = 'x=new aQ.l("queryPodcastEpisodes","query","3539d746cf882f3909660de40b4ef472b3f5893a0761d617c282541de5d412c5",null),y=new aQ.l("addToLibrary","mutation","' + 'a'.repeat(64) + '",null)';
  assert.deepEqual(extractHashes(js), { queryPodcastEpisodes: '3539d746cf882f3909660de40b4ef472b3f5893a0761d617c282541de5d412c5', addToLibrary: 'a'.repeat(64) });
  const ep = parseEpisode({
    __typename: 'Episode', id: '6UaTXth4k40cFE6xRqw8jg', uri: 'spotify:episode:6UaTXth4k40cFE6xRqw8jg', name: 'How To Build The Future: Paul Graham & Amjad Masad',
    duration: { totalMilliseconds: 2654505 }, releaseDate: { isoString: '2026-11-07T17:17:00Z' }, mediaTypes: ['AUDIO', 'VIDEO'],
    coverArt: { sources: [{ url: 'small', width: 64 }, { url: 'mid', width: 300 }, { url: 'big', width: 640 }] },
    podcastV2: { data: { name: 'Y Combinator Startup Podcast', uri: 'spotify:show:1tgqafxZAB0Bjd8nkwVtE4' } },
    playedState: { playPositionMilliseconds: 903000, state: 'IN_PROGRESS' },
  });
  assert.deepEqual([ep.dur, ep.image, ep.show, ep.showId, ep.video, ep.played], [2655, 'mid', 'Y Combinator Startup Podcast', '1tgqafxZAB0Bjd8nkwVtE4', true, { pos: 903, state: 'IN_PROGRESS', done: false }]);
  assert.equal(parseEpisode({ __typename: 'Episode', id: 'x'.repeat(22), name: 'n', playedState: { playPositionMilliseconds: 0, state: 'COMPLETED' } }).played.done, true);
  assert.equal(parseEpisode({ __typename: 'Chapter', id: 'x' }), null);
});
