// Episodes in Notion, end to end against an in-memory Notion: one page per episode whatever the
// platform, twins merged, hand edits respected, no duplicate pages, no useless writes.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fakeNotion } from './helpers/fake-notion.mjs';

register('./helpers/web-resolve.mjs', import.meta.url);
globalThis.__TROVE_TIME_SCALE__ = 0;
Object.assign(process.env, { NOTION_TOKEN: 'test', TROVE_LIBRARY_DS: 'lib-ds', TROVE_SESSION_SECRET: 'test-secret', TROVE_EPISODES_DS: 'ep-ds', BLOB_READ_WRITE_TOKEN: '' });

let N;
let E;
before(async () => {
  const { episodesSchema } = await import('../web/lib/episodes.ts');
  N = fakeNotion(episodesSchema());
  globalThis.fetch = N.fetch;
  E = await import('../web/lib/episodes.ts');
});

const T = 1_794_000_000_000;
const yt = 'dQw4w9WgXcQ';
const sp = '6UaTXth4k40cFE6xRqw8jg';

test('progress lands on one page per episode and identical reports write nothing', async () => {
  const [c1] = await E.applyEvents([{ p: 'yt', id: yt, at: T, title: 'How To Build The Future', channel: 'Y Combinator', dur: 2655, ranges: [[0, 600]], pos: 600, src: 'extension' }]);
  assert.equal(c1.status, 'started');
  assert.equal(c1.yt.id, yt);
  assert.equal(N.live().length, 1);
  const writes = N.calls.update + N.calls.create;
  const [c2] = await E.applyEvents([{ p: 'yt', id: yt, at: T, ranges: [[0, 600]], pos: 600, src: 'extension' }]);
  assert.equal(c2.id, c1.id);
  assert.equal(N.calls.update + N.calls.create, writes, 'nothing changed, nothing written');
  const [c3] = await E.applyEvents([{ p: 'yt', id: yt, at: T + 1000, ranges: [[600, 2500]], pos: 2500, src: 'extension' }]);
  assert.equal(c3.status, 'finished');
  assert.equal(N.live().length, 1);
  const page = N.live()[0];
  assert.equal(page.properties.Status.select.name, 'Finished');
  assert.equal(page.properties['YouTube ID'].rich_text[0].plain_text, yt);
});

test('the Spotify twin joins the same page, and its progress counts', async () => {
  const [c] = await E.applyEvents([{ p: 'sp', id: sp, at: T + 2000, title: 'How To Build The Future', show: 'Y Combinator Startup Podcast', dur: 2655, ext: { pos: 120 }, src: 'spotify', twin: { p: 'yt', id: yt, by: 'catalog' } }]);
  assert.equal(N.live().length, 1);
  assert.equal(c.sp.id, sp);
  assert.equal(c.yt.id, yt);
  assert.equal(c.status, 'finished', 'still finished from YouTube');
  const found = await E.lookupRefs([`sp:${sp}`, `yt:${yt}`, 'yt:aaaaaaaaaaa']);
  assert.equal(found[`sp:${sp}`].id, c.id);
  assert.equal(found[`yt:${yt}`].id, c.id);
  assert.equal(found['yt:aaaaaaaaaaa'], null);
});

test('two pages that turn out to be one episode are merged (the extra goes to the trash)', async () => {
  const a = 'aaaaaaaaaaa';
  const b = 'B'.repeat(22);
  await E.applyEvents([{ p: 'yt', id: a, at: T, title: 'Lightcone ep', dur: 3000, ranges: [[0, 1000]], pos: 1000, src: 'extension' }]);
  await E.applyEvents([{ p: 'sp', id: b, at: T + 5, title: 'Lightcone ep', dur: 3000, ext: { pos: 2000 }, src: 'spotify' }]);
  const before = N.live().length;
  const [c] = await E.applyEvents([{ p: 'sp', id: b, at: T + 10, src: 'page', twin: { p: 'yt', id: a, by: 'page' } }]);
  assert.equal(N.live().length, before - 1);
  assert.equal(c.yt.id, a);
  assert.equal(c.sp.id, b);
  assert.equal(c.resume.p, 'sp');
  assert.equal(c.resume.pos, 2000);
});

test('marking by hand, and "not finished" until finished again', async () => {
  const id = 'ccccccccccc';
  const [c] = await E.applyEvents([{ p: 'yt', id, at: T, title: 'Design Review', dur: 1200, ranges: [[0, 100]], pos: 100, src: 'extension' }]);
  const { card: done } = await E.patchEpisode(c.id, { status: 'finished' });
  assert.equal(done.status, 'finished');
  assert.equal(done.doneOn, 'manual');
  const { card: undone } = await E.patchEpisode(c.id, { status: 'unfinished' });
  assert.notEqual(undone.status, 'finished');
  const { card: moved } = await E.patchEpisode(c.id, { series: 'Design Review' });
  assert.equal(moved.series, 'Design Review');
  // A catalog saying otherwise doesn't override a series set by hand.
  const [again] = await E.applyEvents([{ p: 'yt', id, at: T + 50, src: 'catalog', series: 'Other series', troveShow: 'Y Combinator' }]);
  assert.equal(again.series, 'Design Review');
  assert.equal(again.show, 'Y Combinator');
});

test('unlinking splits the pair for good; linking by hand merges', async () => {
  const y = 'ddddddddddd';
  const s = 'D'.repeat(22);
  const [c] = await E.applyEvents([{ p: 'sp', id: s, at: T, title: 'Wrong pair', dur: 1800, ext: { pos: 900 }, src: 'spotify', twin: { p: 'yt', id: y, by: 'catalog' } }]);
  assert.equal(c.yt.id, y);
  const { card, split } = await E.patchEpisode(c.id, { unlink: 'yt' });
  assert.equal(card.yt, null);
  assert.equal(split, undefined, 'a video never played needs no page of its own');
  // The catalog still pairs them: they stay apart.
  const [after] = await E.applyEvents([{ p: 'sp', id: s, at: T + 10, ext: { pos: 950 }, src: 'spotify', twin: { p: 'yt', id: y, by: 'catalog' } }]);
  assert.equal(after.yt, null);
  assert.equal((await E.lookupRefs([`yt:${y}`]))[`yt:${y}`], null);
  // Playing the video later gives it a page of its own, still apart.
  const [video] = await E.applyEvents([{ p: 'yt', id: y, at: T + 20, title: 'Wrong pair', dur: 1800, ranges: [[0, 60]], pos: 60, src: 'extension', twin: { p: 'sp', id: s, by: 'catalog' } }]);
  assert.notEqual(video.id, after.id);
  assert.equal(video.sp, null);
  // Linking by hand brings them back together.
  const { card: linked } = await E.patchEpisode(after.id, { link: `https://youtu.be/${y}` });
  assert.equal(linked.yt.id, y);
  assert.equal((await E.lookupRefs([`yt:${y}`]))[`yt:${y}`].id, after.id);
});

test('edits made in Notion are picked up', async () => {
  const id = 'eeeeeeeeeee';
  const [c] = await E.applyEvents([{ p: 'yt', id, at: T, title: 'Edited', dur: 600, ranges: [[0, 60]], pos: 60, src: 'extension' }]);
  N.edit(c.id, { Status: { select: { name: 'Finished' } }, Series: { select: { name: 'Hand picked' } }, 'Spotify ID': { rich_text: [{ type: 'text', text: { content: 'E'.repeat(22) } }] } });
  const [card] = Object.values(await E.lookupRefs([`yt:${id}`]));
  assert.equal(card.status, 'finished');
  assert.equal(card.series, 'Hand picked');
  assert.equal(card.sp.id, 'E'.repeat(22));
});

test('duplicate pages from a race are merged even when the report itself changes nothing', async () => {
  const id = 'fffffffffff';
  const [c] = await E.applyEvents([{ p: 'yt', id, at: T, title: 'Race', dur: 1000, ranges: [[0, 300]], pos: 300, src: 'extension' }]);
  // A second instance created its own page for the same video at the same time.
  const data = JSON.stringify({ v: 1, title: 'Race', yt: { id, dur: 1000, ranges: [[500, 900]], pos: 900, at: T + 1 } });
  await globalThis.fetch('https://api.notion.com/v1/pages', { method: 'POST', body: JSON.stringify({ parent: { data_source_id: 'ep-ds' }, properties: { Title: { title: [{ type: 'text', text: { content: 'Race' } }] }, 'YouTube ID': { rich_text: [{ type: 'text', text: { content: id } }] }, Data: { rich_text: [{ type: 'text', text: { content: data } }] } } }) });
  const [after] = await E.applyEvents([{ p: 'yt', id, at: T, ranges: [[0, 300]], pos: 300, src: 'extension' }]);
  assert.equal(after.id, c.id, 'the older page is kept');
  assert.equal(N.live().filter((pg) => pg.properties['YouTube ID']?.rich_text?.[0]?.plain_text === id).length, 1);
  assert.equal(after.resume.pos, 900, "the other page's progress survived");
  assert.ok(Math.abs(after.pct - 0.7) < 0.01);
});

const stored = (id) => JSON.parse(N.pages.get(id).properties.Data.rich_text.map((t) => t.plain_text).join(''));

test('an ad (or the next episode) reporting a short length never cuts progress nor finishes it', async () => {
  const y = 'bbbbbbbbbb1';
  await E.applyEvents([{ p: 'yt', id: y, at: T, title: 'Long', dur: 3600, ranges: [[0, 600], [1200, 2400]], pos: 2400, src: 'extension' }]);
  const [ad] = await E.applyEvents([{ p: 'yt', id: y, at: T + 100, dur: 15, pos: 7, ranges: [[0, 600]], src: 'extension' }]);
  assert.equal(ad.status, 'started');
  const [back] = await E.applyEvents([{ p: 'yt', id: y, at: T + 200, dur: 3600, pos: 610, ranges: [[0, 610]], src: 'extension' }]);
  assert.equal(back.status, 'started');
  assert.deepEqual(stored(back.id).yt.ranges, [[0, 610], [1200, 2400]]);
  assert.equal(stored(back.id).yt.dur, 3600);
});

test('"not finished" holds against what an open tab played before it, not after', async () => {
  const y = 'ccccccccc11';
  const started = Date.now() - 60_000;
  const [c] = await E.applyEvents([{ p: 'yt', id: y, at: started + 1000, title: 'Done', dur: 1000, ranges: [[0, 990]], pos: 990, since: started, src: 'extension' }]);
  assert.equal(c.status, 'finished');
  const { card: undone } = await E.patchEpisode(c.id, { status: 'unfinished' });
  assert.notEqual(undone.status, 'finished');
  // The same tab keeps sending its whole session: ignored.
  const [again] = await E.applyEvents([{ p: 'yt', id: y, at: Date.now() + 1000, dur: 1000, ranges: [[0, 990]], pos: 500, since: started, src: 'extension' }]);
  assert.notEqual(again.status, 'finished');
  assert.equal(again.resume.pos, 500, 'where you are still counts');
  // A new session after the mark counts again.
  const [rewatched] = await E.applyEvents([{ p: 'yt', id: y, at: Date.now() + 2000, dur: 1000, ranges: [[0, 950]], pos: 950, since: Date.now() + 1500, src: 'extension' }]);
  assert.equal(rewatched.status, 'finished');
});

test('looking up many episodes finds all of them', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `zz${String(i).padStart(9, '0')}`);
  for (const id of ids) await E.applyEvents([{ p: 'yt', id, at: T, title: id, dur: 100, ranges: [[0, 50]], pos: 50, src: 'extension' }]);
  const found = await E.lookupRefs(ids.map((i) => `yt:${i}`));
  assert.equal(Object.values(found).filter(Boolean).length, 30);
});

test('unlinking: each half is finished only on its own evidence', async () => {
  const y = 'eeeeeeeee11';
  const s = 'G'.repeat(22);
  const [c] = await E.applyEvents([{ p: 'yt', id: y, at: T, title: 'Watched', dur: 1000, ranges: [[0, 990]], pos: 990, src: 'extension', twin: { p: 'sp', id: s, by: 'catalog' } }]);
  assert.equal(c.status, 'finished');
  const { card, split } = await E.patchEpisode(c.id, { unlink: 'yt' });
  assert.equal(card.sp.id, s);
  assert.equal(card.status, 'new', 'the Spotify episode was never played');
  assert.equal(split.yt.id, y);
  assert.equal(split.status, 'finished', 'the YouTube video was');
});

test('linking another video onto a page moves the old one out instead of mixing them', async () => {
  const s = 'F'.repeat(22);
  const y1 = 'fff1fff1fff';
  const y2 = 'fff2fff2fff';
  const [c] = await E.applyEvents([{ p: 'sp', id: s, at: T, title: 'F', dur: 1000, ext: { pos: 100 }, src: 'spotify', twin: { p: 'yt', id: y1, by: 'catalog' } }]);
  await E.applyEvents([{ p: 'yt', id: y1, at: T + 50, dur: 1000, ranges: [[0, 900]], pos: 900, src: 'extension' }]);
  await E.applyEvents([{ p: 'yt', id: y2, at: T + 10, title: 'F', dur: 1000, ranges: [[0, 200]], pos: 200, src: 'extension' }]);
  const { card, split } = await E.patchEpisode(c.id, { link: `yt:${y2}` });
  assert.equal(card.yt.id, y2);
  assert.deepEqual(stored(card.id).yt.ranges, [[0, 200]], "only y2's own progress");
  assert.notEqual(card.status, 'finished');
  assert.equal(split.yt.id, y1);
  assert.equal(split.status, 'finished', 'y1 keeps its 90% on its own page');
  const found = await E.lookupRefs([`yt:${y1}`, `yt:${y2}`, `sp:${s}`]);
  assert.equal(found[`yt:${y2}`].id, card.id);
  assert.equal(found[`sp:${s}`].id, card.id);
  assert.equal(found[`yt:${y1}`].id, split.id);
  await assert.rejects(E.patchEpisode(split.id, { link: `yt:${y2}` }), /already is another YouTube video/);
});

test('incremental listing for clients', async () => {
  const all = await E.listEpisodes({ sort: 'edited' });
  assert.ok(all.cards.length >= 5);
  const since = all.cards[all.cards.length - 1].updated;
  const fresh = await E.listEpisodes({ since, sort: 'edited' });
  assert.ok(fresh.cards.length >= 1 && fresh.cards.length < all.cards.length);
  const started = await E.listEpisodes({ status: 'started' });
  assert.ok(started.cards.every((c) => c.status === 'started'));
});
