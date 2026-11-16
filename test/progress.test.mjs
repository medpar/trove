// Watch progress: ranges, finishing rules, cross-platform merge and episode matching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Tracker, applyEvent, bestMatch, clock, commonWords, coveredSeconds, markManual, mapPosition, matchAll, mediaRef, mergeRecords,
  normRanges, parseClock, parseHumanDuration, seriesFor, startTimeOf, suggestSeries, summarize, titleSimilarity, sameName
} from '../extension/lib/progress.js';

const T0 = 1_790_000_000_000;

/** Play from `from` to `to` (seconds) at `rate`, one sample per second of wall time. */
function play(tr, from, to, { rate = 1, wall = T0, step = 1 } = {}) {
  let t = from;
  let w = wall;
  tr.sample({ t, wall: w, rate, playing: true });
  while (t < to) {
    t = Math.min(to, t + step * rate);
    w += step * 1000;
    tr.sample({ t, wall: w, rate, playing: true });
  }
  return w;
}

test('ranges merge, bridge tiny gaps and stay bounded', () => {
  assert.deepEqual(normRanges([[10, 20], [0, 5], [19, 30], [31, 40], [50, 49]]), [[0, 5], [10, 40], [49, 50]]);
  assert.deepEqual(normRanges([[0, 100]], { max: 60 }), [[0, 60]]);
  const many = Array.from({ length: 300 }, (_, i) => [i * 10, i * 10 + 5]);
  const capped = normRanges(many);
  assert.ok(capped.length <= 120);
  assert.ok(coveredSeconds(capped) >= coveredSeconds(normRanges(many)));
});

test('tracker counts what was played, never what was skipped', () => {
  const tr = new Tracker();
  let w = play(tr, 0, 120);
  // Seek forward to 1500 and play two minutes: the jump is not counted.
  tr.sample({ t: 1500, wall: w + 500, playing: true, seeking: true });
  w = play(tr, 1500, 1620, { wall: w + 1000 });
  // Seek back to 60 and re-listen: nothing new.
  w = play(tr, 60, 100, { wall: w + 1000 });
  assert.deepEqual(tr.snapshot(), [[0, 120], [1500, 1620]]);
  assert.equal(coveredSeconds(tr.snapshot()), 240);
});

test('tracker handles 2x speed, pauses, ads and long background gaps', () => {
  const tr = new Tracker();
  let w = play(tr, 0, 200, { rate: 2 });
  assert.deepEqual(tr.snapshot(), [[0, 200]]);
  tr.sample({ t: 200, wall: w + 1000, playing: false }); // paused
  w += 600_000;
  // An ad plays (reported as not playing), then the video continues where it was.
  tr.sample({ t: 200, wall: w, playing: true });
  tr.sample({ t: 230, wall: w + 30_000, playing: true }); // 30 s sample gap in a background tab
  assert.deepEqual(tr.snapshot(), [[0, 230]]);
  // The clock jumps ahead more than the wall clock allows: a skip, not playback.
  tr.sample({ t: 400, wall: w + 31_000, playing: true });
  tr.sample({ t: 401, wall: w + 32_000, playing: true });
  assert.deepEqual(tr.snapshot(), [[0, 230], [400, 401]]);
});

const yt = (over = {}) => ({ p: 'yt', id: 'dQw4w9WgXcQ', title: 'How To Build The Future: Paul Graham & Amjad Masad', channel: 'Y Combinator', dur: 2654, src: 'extension', ...over });

test('an episode is finished after ~90% played, not after skipping to the end', () => {
  let r = applyEvent(null, yt({ ranges: [[0, 600]], pos: 600, at: T0 }));
  assert.equal(summarize(r).status, 'started');
  // Jump to the last minute: still not finished.
  r = applyEvent(r, yt({ ranges: [[2600, 2654]], pos: 2654, at: T0 + 1000 }));
  assert.equal(summarize(r).finished, false);
  // Play most of the rest.
  r = applyEvent(r, yt({ ranges: [[600, 2450]], pos: 2450, at: T0 + 2000 }));
  const s = summarize(r);
  assert.equal(s.finished, true);
  assert.equal(s.doneOn, 'yt');
  assert.equal(r.finishedAt, T0 + 2000);
  // Re-watching later never un-finishes it.
  r = applyEvent(r, yt({ ranges: [[0, 30]], pos: 30, at: T0 + 9e6 }));
  assert.equal(summarize(r).finished, true);
  assert.equal(r.finishedAt, T0 + 2000);
});

test('70% played including the ending counts (sponsor reads skipped)', () => {
  const r = applyEvent(null, yt({ ranges: [[0, 1000], [1700, 2654]], pos: 2654, at: T0 }));
  assert.equal(summarize(r).finished, true);
});

test('half on YouTube, half on Spotify = finished across platforms', () => {
  let r = applyEvent(null, yt({ ranges: [[0, 1350]], pos: 1350, at: T0 }));
  r = applyEvent(r, { p: 'sp', id: '6UaTXth4k40cFE6xRqw8jg', dur: 2654.5, ext: { pos: 1300, done: false }, at: T0 + 5000, src: 'spotify' });
  assert.equal(summarize(r).finished, false);
  r = applyEvent(r, { p: 'sp', id: '6UaTXth4k40cFE6xRqw8jg', dur: 2654.5, ranges: [[1300, 2654]], pos: 2654, at: T0 + 9000, src: 'extension' });
  const s = summarize(r);
  assert.equal(s.finished, true);
  assert.equal(s.pct, 1);
});

test("the platform's own played flag finishes it (phone listening)", () => {
  const r = applyEvent(null, { p: 'sp', id: 'x'.repeat(22), dur: 3000, ext: { pos: 0, done: true }, at: T0, src: 'spotify' });
  const s = summarize(r);
  assert.equal(s.finished, true);
  assert.equal(s.doneOn, 'sp');
});

test('resume comes from wherever you were last; unchanged account reports keep their first time', () => {
  let r = applyEvent(null, yt({ ranges: [[0, 300]], pos: 300, at: T0 }));
  r = applyEvent(r, { p: 'sp', id: 'y'.repeat(22), dur: 2654, ext: { pos: 900 }, at: T0 + 3600e3, src: 'spotify' });
  assert.equal(summarize(r).resume.p, 'sp');
  assert.equal(summarize(r).resume.pos, 900);
  // The next hourly sync sees the same position: still "an hour after T0", so a newer YouTube session wins.
  r = applyEvent(r, { p: 'sp', id: 'y'.repeat(22), dur: 2654, ext: { pos: 900 }, at: T0 + 7200e3, src: 'spotify' });
  assert.equal(r.sp.ext.at, T0 + 3600e3);
  r = applyEvent(r, yt({ ranges: [[900, 1000]], pos: 1000, at: T0 + 5000e3 }));
  assert.deepEqual([summarize(r).resume.p, summarize(r).resume.pos], ['yt', 1000]);
  assert.ok(Math.abs(summarize(r).pct - 0.377) < 0.01);
});

test('marking as not finished resets it until you finish again', () => {
  let r = applyEvent(null, yt({ ranges: [[0, 2654]], pos: 2654, at: T0 }));
  assert.equal(summarize(r).finished, true);
  r = markManual(r, false, T0 + 1000);
  assert.equal(summarize(r).finished, false);
  assert.equal(summarize(r).status, 'new');
  r = applyEvent(r, yt({ ranges: [[0, 2600]], pos: 2600, at: T0 + 2000 }));
  assert.equal(summarize(r).finished, true);
  r = markManual(r, true, T0 + 3000);
  assert.equal(summarize(r).finished, true);
  // A stale "played" flag seen before the reset doesn't count.
  let s = applyEvent(null, { p: 'sp', id: 'z'.repeat(22), dur: 1000, ext: { pos: 0, done: true }, at: T0, src: 'spotify' });
  s = markManual(s, false, T0 + 10);
  s = applyEvent(s, { p: 'sp', id: 'z'.repeat(22), dur: 1000, ext: { pos: 0, done: true }, at: T0 + 20, src: 'spotify' });
  assert.equal(summarize(s).finished, false);
});

test('merging two records of one episode is order-independent', () => {
  const a = applyEvent(null, yt({ ranges: [[0, 100]], pos: 100, at: T0 }));
  const b = applyEvent(null, { p: 'sp', id: 'q'.repeat(22), title: 'Spotify title', dur: 2650, ext: { pos: 400 }, at: T0 + 10, src: 'spotify' });
  const ab = mergeRecords(a, b);
  const ba = mergeRecords(b, a);
  assert.deepEqual(summarize(ab), summarize(ba));
  assert.equal(ab.yt.id, 'dQw4w9WgXcQ');
  assert.equal(ab.sp.id, 'q'.repeat(22));
  assert.deepEqual(mergeRecords(ab, ab).yt.ranges, [[0, 100]]);
});

test('positions map across copies of different length', () => {
  assert.deepEqual(mapPosition(600, 2654, 2660), { pos: 600, exact: true });
  assert.deepEqual(mapPosition(600, 3000, 3600), { pos: 720, exact: false });
});

test('time and link helpers', () => {
  assert.equal(clock(3723), '1:02:03');
  assert.equal(clock(95), '1:35');
  assert.equal(parseClock('44:14'), 2654);
  assert.equal(parseHumanDuration('44 min 14 sec'), 2654);
  assert.equal(parseHumanDuration('1 hr 2 min'), 3720);
  assert.equal(parseHumanDuration('3 min left'), 180);
  assert.equal(startTimeOf('https://youtu.be/dQw4w9WgXcQ?t=1h2m3s'), 3723);
  assert.equal(startTimeOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=95s'), 95);
  assert.equal(startTimeOf('https://open.spotify.com/episode/6UaTXth4k40cFE6xRqw8jg?t=120'), 120);
  assert.deepEqual(mediaRef('https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share'), { p: 'yt', id: 'dQw4w9WgXcQ' });
  assert.deepEqual(mediaRef('https://open.spotify.com/intl-es/episode/6UaTXth4k40cFE6xRqw8jg?si=abc'), { p: 'sp', id: '6UaTXth4k40cFE6xRqw8jg' });
  assert.deepEqual(mediaRef('spotify:episode:6UaTXth4k40cFE6xRqw8jg'), { p: 'sp', id: '6UaTXth4k40cFE6xRqw8jg' });
  assert.equal(mediaRef('https://example.com'), null);
});

// Real titles from the YC podcast on Spotify vs YouTube.
const SPOTIFY = [
  { id: 's1', title: 'How To Build The Future: Paul Graham & Amjad Masad', dur: 2654, date: '2026-11-07T17:17:00Z' },
  { id: 's2', title: 'How To Go From Researcher to Founder', dur: 600, date: '2026-11-04T15:00:00Z' },
  { id: 's3', title: 'What Happens When Everyone Can Build Software', dur: 2940, date: '2026-10-30T15:00:00Z' },
  { id: 's4', title: 'Boris Cherny: Building Claude Code', dur: 2160, date: '2026-07-28T15:00:00Z' },
  { id: 's5', title: 'Sam Altman: "Never a Better Time to Do a Startup"', dur: 2340, date: '2026-07-28T15:00:00Z' },
  { id: 's6', title: 'Paul Graham On Startups, Ambition, and Great Founders', dur: 1260, date: '2026-09-05T15:00:00Z' },
];
const YOUTUBE = [
  { id: 'y1', title: 'Amjad Masad: Replit and the AI coding era | How To Build The Future', dur: 2660, date: '2026-11-07T16:00:00Z' },
  { id: 'y3', title: 'What Happens When Everyone Can Build Software? | Lightcone Podcast', dur: 2945, date: '2026-10-30T14:00:00Z' },
  { id: 'y4', title: 'Boris Cherny: Building Claude Code', dur: 2158, date: '2026-07-27T18:00:00Z' },
  { id: 'y5', title: 'Sam Altman: Never a Better Time to Do a Startup', dur: 2343, date: '2026-07-28T10:00:00Z' },
  { id: 'y9', title: 'How To Get Your First 10 Customers', dur: 610, date: '2026-11-04T15:00:00Z' },
  { id: 'y6', title: 'Paul Graham on Startups, Ambition and Great Founders (Full Interview)', dur: 1262, date: '2026-09-05T08:00:00Z' },
];

test('episodes of a show are paired across Spotify and YouTube', () => {
  const stop = commonWords([...SPOTIFY, ...YOUTUBE].map((x) => x.title));
  const pairs = matchAll(SPOTIFY, YOUTUBE, { stop });
  const got = Object.fromEntries(pairs.map((p) => [p.a.id, p.b.id]));
  assert.equal(got.s1, 'y1', 'same day + same length + shared names');
  assert.equal(got.s3, 'y3');
  assert.equal(got.s4, 'y4');
  assert.equal(got.s5, 'y5');
  assert.equal(got.s6, 'y6');
  assert.equal(got.s2, undefined, 'same day and length but a different talk');
});

test('similar titles with different episode numbers or lengths are not linked', () => {
  assert.ok(titleSimilarity('Lex Fridman #401: Sam Altman', 'Lex Fridman #419: Sam Altman') < 0.6);
  assert.equal(bestMatch({ title: 'Startup School: Pricing', dur: 1800 }, [{ id: 'a', title: 'Startup School: Pricing', dur: 300 }]), null);
  assert.equal(bestMatch({ title: 'Design Review #3' }, [{ id: 'a', title: 'Design Review #3' }, { id: 'b', title: 'Design Review #3' }]), null, 'ambiguous');
  assert.equal(bestMatch({ title: 'Design Review #3', dur: 900 }, [{ id: 'a', title: 'Design Review #3', dur: 905 }]).c.id, 'a');
});

test('series from rules and suggested from repeated prefixes', () => {
  const rules = [{ series: 'How To Build The Future', pattern: 'how to build the future' }, { series: 'Lightcone', pattern: '/\\|\\s*lightcone/' }];
  assert.equal(seriesFor('How To Build The Future: Demis Hassabis', rules), 'How To Build The Future');
  assert.equal(seriesFor('AI agents explained | Lightcone Podcast', rules), 'Lightcone');
  assert.equal(seriesFor('Something else', rules), null);
  const sug = suggestSeries(['How To Build The Future: A', 'How To Build The Future: B', 'How to Build the Future: C', 'X | Lightcone Podcast', 'Y | Lightcone Podcast', 'Z | Lightcone Podcast', 'Other']);
  assert.deepEqual(sug.map((s) => s.name), ['Lightcone Podcast']);
  assert.equal(suggestSeries(['How To Build The Future: A', 'How To Build The Future: B', 'How To Build The Future: C'])[0].name, 'How To Build The Future');
});

test('a YouTube channel and a podcast are matched by name, not by filler words', () => {
  assert.ok(sameName('Lex Fridman', 'Lex Fridman Podcast'));
  assert.ok(sameName('Y Combinator', 'Y Combinator Startup Podcast'));
  assert.ok(sameName('David Senra', 'David Senra'));
  assert.ok(!sameName('Zenvora Productions', 'Lex Fridman Podcast'), 're-upload channel');
  assert.ok(!sameName('The Official Podcast Channel', 'The Podcast Show'), 'only filler in common');
  assert.ok(!sameName('', 'Lex Fridman Podcast'));
  assert.ok(!sameName(null, undefined));
});

test("YouTube's 'seen, no position' marks a video without inventing a position, and never hides a real one", () => {
  const T = 1_800_000_000_000;
  // Seen only: started, no %, no resume point.
  let r = applyEvent(null, { p: 'yt', id: 'aaaaaaaaaaa', at: T, dur: 3600, ext: { pos: 0, done: false, seen: true }, src: 'youtube' });
  let s = summarize(r);
  assert.equal(s.status, 'started');
  assert.equal(s.pct, 0);
  assert.equal(s.resume, null);
  assert.equal(s.seen, 'yt');
  // A real position from YouTube later takes over.
  r = applyEvent(r, { p: 'yt', id: 'aaaaaaaaaaa', at: T + 1000, dur: 3600, ext: { pos: 1332, done: false }, src: 'youtube' });
  s = summarize(r);
  assert.equal(s.seen, null);
  assert.equal(s.resume.pos, 1332);
  // The extension saw you watch half; YouTube later only says "seen": the extension's position stays.
  let q = applyEvent(null, { p: 'yt', id: 'bbbbbbbbbbb', at: T, dur: 3000, ranges: [[0, 1500]], pos: 1500, src: 'extension' });
  q = applyEvent(q, { p: 'yt', id: 'bbbbbbbbbbb', at: T + 5000, ext: { pos: 0, done: false, seen: true }, src: 'youtube' });
  s = summarize(q);
  assert.equal(s.status, 'started');
  assert.equal(s.resume.pos, 1500);
  assert.equal(s.seen, null);
});

test('a finished video stays finished when you open it again or start rewatching it', () => {
  const T = 1_800_000_000_000;
  // Finished by YouTube's own report; a day later you rewatch and YouTube says 37%.
  let g = applyEvent(null, { p: 'yt', id: 'ddddddddddd', at: T, dur: 1000, ext: { pos: 1000, done: true }, src: 'youtube' });
  assert.equal(summarize(g).status, 'finished');
  g = applyEvent(g, { p: 'yt', id: 'ddddddddddd', at: T + 86_400_000, dur: 1000, ext: { pos: 370, done: false }, src: 'youtube' });
  assert.equal(summarize(g).status, 'finished', 'rewatching keeps it finished');
  assert.equal(summarize(g).resume.pos, 370, 'and remembers where the rewatch is');
  // Finished in the browser; opening it again only gets a "seen" from YouTube, and a few seconds played.
  let f = applyEvent(null, { p: 'yt', id: 'ccccccccccc', at: T, dur: 600, ranges: [[0, 590]], pos: 590, src: 'extension' });
  assert.equal(summarize(f).status, 'finished');
  f = applyEvent(f, { p: 'yt', id: 'ccccccccccc', at: T + 9000, ext: { pos: 0, done: false, seen: true }, src: 'youtube' });
  f = applyEvent(f, { p: 'yt', id: 'ccccccccccc', at: T + 9999, ranges: [[0, 12]], pos: 12, since: T + 9990, src: 'extension' });
  assert.equal(summarize(f).status, 'finished');
  // Only "Not finished" by hand undoes it.
  assert.equal(summarize(markManual(f, false, T + 20000)).status, 'new');
});

test('a play Trove found already finished keeps "before <day it found out>", never a guessed date', () => {
  const T = 1_800_000_000_000;
  // First import: finished on Spotify, time unknown.
  let r = applyEvent(null, { p: 'sp', id: 'S'.repeat(22), at: T, dur: 3000, ext: { pos: 3000, done: true }, before: true, src: 'spotify' });
  let s = summarize(r);
  assert.equal(s.status, 'finished');
  assert.equal(s.finishedAt, T);
  assert.equal(s.finishedBefore, true);
  assert.equal(s.last.before, true);
  // Later reports don't move a finish date (sticky), and say nothing new about it.
  r = applyEvent(r, { p: 'sp', id: 'S'.repeat(22), at: T + 86_400_000, dur: 3000, ext: { pos: 600, done: false }, src: 'spotify' });
  s = summarize(r);
  assert.equal(s.finishedAt, T);
  assert.equal(s.finishedBefore, true);
  assert.equal(s.last.before, undefined, 'the rewatch itself was seen happen');
  // A finish Trove sees happen is dated exactly.
  const k = applyEvent(null, { p: 'sp', id: 'K'.repeat(22), at: T, dur: 3000, ext: { pos: 3000, done: true }, src: 'spotify' });
  assert.equal(summarize(k).finishedBefore, false);
  // Merging two pages keeps the earliest finish and whether it was only "by then".
  const m = mergeRecords({ ...k, finishedAt: T + 5000 }, { ...r, finishedAt: T, finishedBefore: true });
  assert.equal(m.finishedAt, T);
  assert.equal(m.finishedBefore, true);
  // "Not finished" by hand forgets it; finishing by hand is dated exactly.
  const n = markManual(r, false, T + 10);
  assert.equal(n.finishedBefore, undefined);
  assert.equal(summarize(markManual(n, true, T + 20)).finishedBefore, false);
});
