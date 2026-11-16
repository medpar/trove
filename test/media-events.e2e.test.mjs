// The extension's progress through the real HTTP route (POST /api/media/events), with the event its
// YouTube script sent on youtube.com: watched 0:00–0:16, skipped to 10:00, back to 1:40, closed mid-play.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fakeNotion } from './helpers/fake-notion.mjs';

register('./helpers/web-resolve.mjs', import.meta.url);
globalThis.__TROVE_TIME_SCALE__ = 0;
Object.assign(process.env, { NOTION_TOKEN: 'test', TROVE_LIBRARY_DS: 'lib-ds', TROVE_SESSION_SECRET: 'events-secret', TROVE_EPISODES_DS: 'ep-ds', BLOB_READ_WRITE_TOKEN: 'fake', TROVE_API_KEYS: 'Extension:ext-key-123' });

let N;
let route;
before(async () => {
  const { episodesSchema } = await import('../web/lib/episodes.ts');
  N = fakeNotion(episodesSchema());
  globalThis.fetch = N.fetch;
  route = await import('../web/app/api/media/events/route.ts');
});

const post = async (body, key = 'ext-key-123') => {
  const res = await route.POST(new Request('http://trove.test/api/media/events', { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) }), {});
  return { status: res.status, body: await res.json() };
};

const V = 'Q78dJ0vkWe8';
const T0 = Date.now() - 3600e3;
const captured = { p: 'yt', id: V, at: T0 + 40_000, since: T0, dur: 2654.5, pos: 108.1, ranges: [[0, 16.2], [100, 108.1], [600, 607.4]], src: 'extension', title: 'How To Build The Future: Paul Graham & Amjad Masad', channel: 'Y Combinator' };
const later = (ms, extra) => ({ ...captured, at: T0 + ms, ...extra });

test('needs an API key', async () => {
  assert.equal((await post({ events: [captured] }, null)).status, 401);
  assert.equal((await post({ events: [captured] }, 'wrong')).status, 401);
});

test("the extension's events are stored as sent, and skipped parts never count", async () => {
  const r1 = await post({ events: [captured] });
  assert.equal(r1.status, 200);
  const [c1] = r1.body.cards;
  assert.equal(c1.yt.id, V);
  assert.equal(c1.show, 'Y Combinator');
  assert.equal(c1.status, 'new', 'half a minute of peeking is not "started"');
  assert.ok(c1.pct > 0.011 && c1.pct < 0.013, 'only the 32 seconds played');
  // The session goes on for ten minutes: started, and resume where it stopped.
  const [c2] = (await post({ events: [later(700_000, { pos: 708, ranges: [[0, 16.2], [100, 708], [600, 607.4]] })] })).body.cards;
  assert.equal(c2.status, 'started');
  assert.equal(c2.resume.p, 'yt');
  assert.equal(c2.resume.pos, 708);
  // Jumping to the end and watching the last minute does not finish it.
  const [c3] = (await post({ events: [later(800_000, { since: T0 + 750_000, pos: 2654, ranges: [[2590, 2654.5]] })] })).body.cards;
  assert.equal(c3.status, 'started');
  // Watching the rest does.
  const [c4] = (await post({ events: [later(3_000_000, { since: T0 + 900_000, pos: 2654, ranges: [[708, 2654.5]] })] })).body.cards;
  assert.equal(c4.status, 'finished');
  assert.equal(N.live().length, 1, 'one page for the episode');
});

test('rejects what is not an event; the same report twice writes nothing', async () => {
  assert.equal((await post({ events: [{ p: 'yt', id: 'not an id' }] })).status, 400);
  const writes = N.calls.create + N.calls.update;
  const again = await post({ events: [later(3_000_000, { since: T0 + 900_000, pos: 2654, ranges: [[708, 2654.5]] })] });
  assert.equal(again.status, 200);
  assert.equal(again.body.cards[0].status, 'finished');
  assert.equal(N.calls.create + N.calls.update, writes);
});
