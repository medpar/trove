// Trove 3: what people type in Telegram/email, search vectors, feeds and highlight notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linksIn, parseDirectives, resolveCollection, resolveTag } from '../web/lib/directives.ts';
import { dot, packVector, unpackVector } from '../web/lib/vector.ts';
import { parseFeed } from '../web/lib/feed-parse.ts';

test('directives: #tags, @Collection, flags, and the rest is the note', () => {
  const d = parseDirectives('https://example.com/a?x=1#frag great read #ai #dev_tools @Dev/AI !fav');
  assert.deepEqual(d.tags, ['ai', 'dev tools']);
  assert.equal(d.collection, 'Dev/AI');
  assert.equal(d.favorite, true);
  assert.equal(d.rest, 'great read');
  const q = parseDirectives('@"Side projects" !read !raw #tag. remember this');
  assert.equal(q.collection, 'Side projects');
  assert.equal(q.read, true);
  assert.equal(q.autofile, false);
  assert.deepEqual(q.tags, ['tag']);
  assert.equal(q.rest, 'remember this');
  assert.equal(parseDirectives('email me at a@b.com').collection, undefined);
  assert.equal(parseDirectives('⭐ keep').favorite, true);
});

test('links: plain, entity and hidden text links, deduplicated', () => {
  const msg = {
    text: 'see example.com/x and https://a.com/b). also this',
    entities: [
      { type: 'url', offset: 4, length: 13 },
      { type: 'text_link', offset: 44, length: 4, url: 'https://hidden.com/p' },
    ],
  };
  assert.deepEqual(linksIn(msg), ['https://example.com/x', 'https://hidden.com/p', 'https://a.com/b']);
  assert.deepEqual(linksIn({ caption: 'no links here' }), []);
});

test('collections and tags resolve to existing names', () => {
  const known = ['Dev/AI', 'Reading', 'Startups/Sales', 'Side projects'];
  assert.equal(resolveCollection('ai', known), 'Dev/AI');
  assert.equal(resolveCollection('reading', known), 'Reading');
  assert.equal(resolveCollection('sideprojects', known), 'Side projects');
  assert.equal(resolveCollection('New/Thing', known), 'New/Thing');
  assert.equal(resolveTag('LLM', ['llm', 'ai']), 'llm');
  assert.equal(resolveTag('dev-tools', ['dev tools']), 'dev tools');
});

test('vectors survive int8 packing and still rank like cosine', () => {
  const unit = (a) => {
    const n = Math.hypot(...a);
    return Float32Array.from(a.map((x) => x / n));
  };
  const rnd = (seed) => Array.from({ length: 512 }, (_, i) => Math.sin(seed * 997 + i * 13.37));
  const a = unit(rnd(1));
  const near = unit(rnd(1).map((x, i) => x + 0.15 * Math.cos(i)));
  const far = unit(rnd(7));
  const pa = packVector(a);
  assert.match(pa, /^v1:/);
  assert.ok(pa.length < 2000, 'fits in one Notion text run');
  const [qa, qn, qf] = [pa, packVector(near), packVector(far)].map(unpackVector);
  assert.equal(qa.length, 512);
  assert.ok(dot(a, qn) > dot(a, qf), 'near beats far after quantization');
  assert.ok(Math.abs(dot(a, qa) / (127 * 4) - 1) < 0.05);
  assert.equal(unpackVector('nope'), null);
});

test('feeds: RSS and Atom entries with links, dates, summaries and images', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Blog</title><link>https://blog.example.com</link>
    <item><title>Post &amp; one</title><link>/p/1</link><pubDate>Tue, 10 Nov 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Hello <b>world</b></p><img src="https://img/x.jpg">]]></description></item>
    <item><title>Two</title><guid>https://blog.example.com/p/2</guid><media:thumbnail url="https://img/2.jpg"/></item></channel></rss>`;
  const r = parseFeed(rss, 'https://blog.example.com/feed');
  assert.equal(r.title, 'Blog');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].url, 'https://blog.example.com/p/1');
  assert.equal(r.entries[0].title, 'Post & one');
  assert.equal(r.entries[0].summary, 'Hello world');
  assert.equal(r.entries[0].image, 'https://img/x.jpg');
  assert.equal(r.entries[0].date, '2026-11-10T10:00:00.000Z');
  assert.equal(r.entries[1].url, 'https://blog.example.com/p/2');
  assert.equal(r.entries[1].image, 'https://img/2.jpg');
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Channel</title><link rel="alternate" href="https://yt.example"/>
    <entry><title>Video</title><link rel="alternate" href="https://yt.example/v/1"/><published>2026-11-01T00:00:00Z</published><summary>Sum</summary></entry></feed>`;
  const f = parseFeed(atom, 'https://yt.example/feed');
  assert.equal(f.site, 'https://yt.example');
  assert.equal(f.entries[0].url, 'https://yt.example/v/1');
  assert.equal(f.entries[0].summary, 'Sum');
});
