// What the Telegram bot answers when you share a YouTube or Spotify link from the iPhone apps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/web-resolve.mjs', import.meta.url);
const { mediaLine } = await import('../web/lib/media-status.ts');

// #494 as Trove holds it: 43% heard, stopped at 1:04:28 on Spotify; the YouTube video is 8759 s long.
const lex = {
  status: 'started', pct: 0.425, seen: null, finishedAt: null, doneOn: null,
  yt: { id: 'vif8NQcjVf0', dur: 8759, title: null }, sp: { id: '0BGcaYvcDPkvBzFmkRI5uY', dur: 9105, title: '#494' },
  resume: { p: 'sp', pos: 3868, dur: 9105, at: 1, src: 'spotify' },
};

test('shared from the YouTube app: where you stopped on Spotify, and a link to continue on YouTube at the same moment', () => {
  const line = mediaLine(lex, { p: 'yt', id: 'vif8NQcjVf0' });
  assert.match(line, /43% heard, stopped at 1:04:28 on Spotify/);
  assert.match(line, /href="https:\/\/www\.youtube\.com\/watch\?v=vif8NQcjVf0&amp;t=3721s"/);
  assert.match(line, /Continue on YouTube at 1:02:01/);
});

test('shared from the Spotify app: continue on Spotify where you stopped', () => {
  assert.match(mediaLine(lex, { p: 'sp', id: '0BGcaYvcDPkvBzFmkRI5uY' }), /Continue on Spotify at 1:04:28/);
});

test('finished, seen without a position, and never played', () => {
  assert.match(mediaLine({ status: 'finished', doneOn: 'yt', finishedAt: Date.UTC(2026, 10, 15), pct: 1 }, { p: 'sp', id: 'x'.repeat(22) }), /Already finished on YouTube \(15 Nov 2026\)/);
  assert.equal(mediaLine({ status: 'started', seen: 'yt', pct: 0, resume: null }, { p: 'yt', id: 'a'.repeat(11) }), '◐ Seen on YouTube; it kept no position.');
  assert.match(mediaLine(null, { p: 'yt', id: 'a'.repeat(11) }), /Not played yet/);
});
