#!/usr/bin/env node
// A fake Trove API filled with a fictional sample library, for the screenshots in the README and on the
// project site. Nothing here touches Notion or a real library; every request is answered from memory.
//
//   node scripts/screenshots/demo-server.mjs      # http://127.0.0.1:8790 (PORT to change)
//
// capture.py points the web app (and the agent bridge) at it. Any API key is accepted.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8790);
const NOW = Date.parse('2026-11-16T09:30:00Z');
const ago = (h) => new Date(NOW - h * 3600e3).toISOString();

// ---------- covers: generated SVG art, so the screenshots carry no third-party images ----------

const PALETTES = [
  ['#ff6b35', '#f7c59f', '#1a1a2e'], ['#2b2d42', '#8d99ae', '#ef233c'], ['#0b3954', '#bfd7ea', '#ff5a5f'],
  ['#264653', '#2a9d8f', '#e9c46a'], ['#3d348b', '#7678ed', '#f7b801'], ['#132a13', '#4f772d', '#ecf39e'],
  ['#5f0f40', '#9a031e', '#fb8b24'], ['#03045e', '#0077b6', '#90e0ef'], ['#1b263b', '#415a77', '#e0e1dd'],
  ['#6d597a', '#b56576', '#eaac8b'], ['#14213d', '#fca311', '#e5e5e5'], ['#004b23', '#38b000', '#ccff33'],
];

function rng(seed) {
  let s = seed * 9301 + 49297;
  return () => ((s = (s * 9301 + 49297) % 233280) / 233280);
}

function cover(name) {
  const [kind, n] = name.split('-');
  const seed = Number(n) || 1;
  const r = rng(seed);
  const [a, b, c] = PALETTES[seed % PALETTES.length];
  const W = 800, H = kind === 'tall' ? 1100 : kind === 'square' ? 800 : 450;
  let art = '';
  const style = seed % 5;
  if (style === 0) for (let i = 0; i < 9; i++) art += `<circle cx="${r() * W}" cy="${r() * H}" r="${40 + r() * 220}" fill="${[b, c][i % 2]}" opacity="${0.35 + r() * 0.5}"/>`;
  else if (style === 1) for (let i = 0; i < 7; i++) art += `<path d="M0 ${H * (0.2 + i * 0.12)} C ${W * 0.3} ${H * (r())}, ${W * 0.6} ${H * (r() + 0.3)}, ${W} ${H * (0.1 + i * 0.13)} L ${W} ${H} L 0 ${H} Z" fill="${[b, c, a][i % 3]}" opacity="0.55"/>`;
  else if (style === 2) {
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
      if (r() > 0.45) art += `<rect x="${(x * W) / 8 + 8}" y="${(y * H) / 8 + 8}" width="${W / 8 - 16}" height="${H / 8 - 16}" rx="${r() > 0.5 ? 999 : 10}" fill="${r() > 0.5 ? b : c}" opacity="0.85"/>`;
    }
  }
  else if (style === 3) for (let i = 0; i < 14; i++) art += `<rect x="${r() * W - 100}" y="${r() * H - 50}" width="${120 + r() * 360}" height="${18 + r() * 40}" rx="20" transform="rotate(${-30 + r() * 60} ${W / 2} ${H / 2})" fill="${[b, c][i % 2]}" opacity="0.8"/>`;
  else {
    art += `<circle cx="${W * 0.62}" cy="${H * 0.45}" r="${Math.min(W, H) * 0.32}" fill="${c}"/>`;
    for (let i = 0; i < 18; i++) art += `<line x1="0" y1="${(i * H) / 18}" x2="${W}" y2="${(i * H) / 18 + 60}" stroke="${b}" stroke-width="3" opacity="0.5"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${a}" stop-opacity="0.82"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${art}</svg>`;
}

const C = (kind, n) => `/demo-cover/${kind}-${n}.svg`;

// ---------- the library ----------

const base = { db: 'library', icon: null, published: null, favorite: false, read: false, note: '', status: null, highlights: 0, readingTime: null, duration: null, remind: null, source: null, via: '', notionUrl: 'https://www.notion.so/', progress: null, archive: null, snapshot: false, summary: '' };
let k = 0;
const item = (o) => ({ ...base, id: `demo-${++k}`, created: ago(k * 5), updated: ago(k * 5), excerpt: '', author: '', tags: [], cover: null, platform: '', ...o });

const ITEMS = [
  item({ title: 'The quiet comeback of local-first software', url: 'https://inkandswitch.com/essays/local-first-revisited', domain: 'inkandswitch.com', type: 'Article', collection: 'Dev/Architecture', tags: ['local-first', 'crdt', 'sync'], cover: C('wide', 3), author: 'Lena Okafor', readingTime: 14, favorite: true, highlights: 3, snapshot: true, archive: 'https://web.archive.org/', summary: 'Why apps that keep your data on your device first are winning again, and what CRDTs changed.', excerpt: 'Ten years after the first local-first manifesto, sync engines have finally caught up with the idea.', note: 'Good framing for the offline mode talk.' }),
  item({ title: 'Designing a calm interface: notes from a year of building', url: 'https://www.youtube.com/watch?v=calm-ui', domain: 'youtube.com', platform: 'YouTube', type: 'Video', collection: 'Design', tags: ['ui', 'talks'], cover: C('wide', 4), author: 'Interface Club', duration: 2735, summary: 'A talk on reducing visual noise, motion with purpose and defaults that respect attention.' }),
  item({ title: 'Small models are eating the edge', url: 'https://arxiv.org/abs/2611.04821', domain: 'arxiv.org', type: 'Paper', collection: 'AI/Research', tags: ['llm', 'on-device', 'paper'], cover: C('wide', 7), author: 'R. Iyer, M. Santos, K. Wei', readingTime: 32, summary: 'Benchmarks 40 sub-4B models on phones and laptops; distillation closes most of the gap on everyday tasks.', read: true }),
  item({ title: 'A thread on pricing developer tools without making people angry', url: 'https://x.com/devtoolsdana/status/1', domain: 'x.com', platform: 'X', type: 'Post', source: 'X', collection: 'X bookmarks', tags: ['pricing', 'devtools'], author: 'Dana Whitfield', excerpt: '1/ Most devtool pricing pages fail the same way: they price the thing the founder is proud of, not the thing the team actually pays for. A few patterns that worked for us 🧵', stats: { likes: 4820, views: 391000, thread: 9 } }),
  item({ title: 'tinybase/sync-kit', url: 'https://github.com/example/sync-kit', domain: 'github.com', platform: 'GitHub', type: 'Repo', collection: 'GitHub stars', tags: ['typescript', 'sync'], cover: C('wide', 9), author: 'example', excerpt: 'A 6 kB reactive store with conflict-free sync over any transport.', summary: 'Reactive key-value store with CRDT sync, persisters for SQLite and IndexedDB.' }),
  item({ title: 'Kyoto in the rain', url: 'https://www.pinterest.com/pin/kyoto', domain: 'pinterest.com', platform: 'Pinterest', type: 'Image', collection: 'Pinterest/Travel', tags: ['japan'], cover: C('tall', 10) }),
  item({ title: 'How we cut our cloud bill by 60% without a rewrite', url: 'https://engineering.example.com/cloud-bill', domain: 'engineering.example.com', type: 'Article', collection: 'Dev/Infra', tags: ['costs', 'aws'], cover: C('wide', 11), author: 'Priya Raman', readingTime: 9, summary: 'Right-sizing, spot instances for batch work and moving cold logs to object storage.' }),
  item({ title: 'Idea: one inbox for everything I mean to read', url: '', domain: '', type: 'Note', collection: 'Notes', tags: ['ideas'], excerpt: 'What if read-later, newsletters and podcast episodes lived in a single queue, sorted by how long they take? Morning: 5-minute items. Commute: the podcast. Weekend: the long essays.', via: 'Telegram', source: 'Telegram' }),
  item({ title: 'The Dirt Road Diaries — Episode 112: Starting over at forty', url: 'https://open.spotify.com/episode/demo', domain: 'open.spotify.com', platform: 'Spotify', type: 'Audio', collection: 'Podcasts', tags: ['career'], cover: C('square', 12), duration: 4380 }),
  item({ title: 'Typography for long-form reading on screens', url: 'https://type.example.org/long-form', domain: 'type.example.org', type: 'Article', collection: 'Design', tags: ['typography', 'reading'], cover: C('wide', 13), author: 'Hugo Marchetti', readingTime: 11, favorite: true, highlights: 2 }),
  item({ title: 'Field guide to Postgres indexes', url: 'https://pg.example.dev/indexes', domain: 'pg.example.dev', type: 'Article', collection: 'Dev/Databases', tags: ['postgres', 'performance'], cover: C('wide', 14), readingTime: 18, read: true }),
  item({ title: 'Mid-century living room, warm wood and green', url: 'https://www.pinterest.com/pin/room', domain: 'pinterest.com', platform: 'Pinterest', type: 'Image', collection: 'Pinterest/Home', tags: ['interiors'], cover: C('tall', 15) }),
  item({ title: 'Show HN: I built a keyboard-first bookmark manager', url: 'https://news.ycombinator.com/item?id=1', domain: 'news.ycombinator.com', platform: 'Hacker News', type: 'Post', collection: 'Dev', tags: ['show-hn'], excerpt: 'After losing years of bookmarks twice, I wanted something that archives the page itself. Feedback welcome.', stats: { points: 412, comments: 187 } }),
  item({ title: 'Quarterly planning template (Q1 2027).pdf', url: 'https://files.trove/plan.pdf', domain: 'trove', type: 'Document', collection: 'Work', tags: ['planning'], cover: C('wide', 16), via: 'Shortcut' }),
  item({ title: 'Why your sourdough is flat', url: 'https://bread.example.com/flat-sourdough', domain: 'bread.example.com', type: 'Article', collection: 'Cooking', tags: ['bread'], cover: C('wide', 17), readingTime: 6, remind: ago(-30) }),
  item({ title: 'A visual introduction to attention', url: 'https://www.youtube.com/watch?v=attention', domain: 'youtube.com', platform: 'YouTube', type: 'Video', collection: 'AI/Learning', tags: ['transformers', 'explainer'], cover: C('wide', 18), duration: 1580, progress: 64 }),
  item({ title: 'Brutalist poster series', url: 'https://www.pinterest.com/pin/poster', domain: 'pinterest.com', platform: 'Pinterest', type: 'Image', collection: 'Pinterest/Graphic', tags: ['posters'], cover: C('tall', 19) }),
  item({ title: 'r/selfhosted: what do you back up and how often?', url: 'https://www.reddit.com/r/selfhosted/comments/1', domain: 'reddit.com', platform: 'Reddit', type: 'Post', collection: 'Dev/Infra', tags: ['backups', 'homelab'], excerpt: 'I keep a nightly restic job to B2 and a weekly offline disk. Curious how others handle databases.', stats: { points: 1320, comments: 402 } }),
  item({ title: 'The 37signals guide to writing pitches', url: 'https://writing.example.com/pitches', domain: 'writing.example.com', type: 'Article', collection: 'Work', tags: ['writing', 'product'], cover: C('wide', 20), readingTime: 8 }),
  item({ title: 'Coastal walk, Portugal', url: 'https://images.trove/coast.jpg', domain: 'trove', type: 'Image', collection: 'Travel', tags: ['portugal'], cover: C('tall', 21), via: 'Telegram' }),
  item({ title: 'Ask an expert: building habits that stick', url: 'https://www.youtube.com/watch?v=habits', domain: 'youtube.com', platform: 'YouTube', type: 'Video', collection: 'Podcasts', tags: ['habits'], cover: C('wide', 22), duration: 3920 }),
  item({ title: 'Bluesky: notes on federated moderation', url: 'https://bsky.app/profile/demo/post/1', domain: 'bsky.app', platform: 'Bluesky', type: 'Post', collection: 'Reading', tags: ['social', 'moderation'], excerpt: 'Moderation that composes: labelers you subscribe to, lists you share, and defaults that are yours to change.' }),
  item({ title: 'Color systems that survive dark mode', url: 'https://design.example.com/color-dark', domain: 'design.example.com', type: 'Article', collection: 'Design', tags: ['color', 'dark-mode'], cover: C('wide', 23), readingTime: 12 }),
  item({ title: 'Minimal desk setups', url: 'https://www.pinterest.com/pin/desk', domain: 'pinterest.com', platform: 'Pinterest', type: 'Image', collection: 'Pinterest/Home', tags: ['workspace'], cover: C('square', 24) }),
  ...[
    ['Tiny cabin in the fjords', 'Travel', 'tall', 35], ['Risograph color studies', 'Graphic', 'square', 36], ['Terracotta kitchen', 'Home', 'tall', 37],
    ['Swiss poster grid', 'Graphic', 'tall', 38], ['Desert road at dusk', 'Travel', 'square', 39], ['Reading nook ideas', 'Home', 'tall', 40],
    ['Bauhaus shapes', 'Graphic', 'square', 41], ['Lisbon tiles', 'Travel', 'tall', 42],
  ].map(([title, board, kind, n]) => item({ title, url: `https://www.pinterest.com/pin/${n}`, domain: 'pinterest.com', platform: 'Pinterest', type: 'Image', collection: `Pinterest/${board}`, tags: [board.toLowerCase()], cover: C(kind, n) })),
];

const MARKDOWN = `Ten years after the first local-first manifesto, sync engines have finally caught up with the idea. The promise was simple: your data lives on your device, the network is an optimization, and the cloud is a place to meet, not a place to rent.

## What changed

Three things moved at once. CRDT libraries got small and fast enough to ship in a web page. Browsers gained real storage, with SQLite compiled to WebAssembly writing to the origin private file system. And people grew tired of apps that show a spinner on a plane.

> The best sync engine is the one you never notice: you edit, it saves, and the other device simply agrees.

The result is a new kind of app that opens instantly, works offline by default and merges edits from many devices without a conflict dialog.

## The hard parts

Local-first is not free. Schemas still change, and every client in the wild must understand the old and the new shape at the same time. Permissions are harder when there is no single server to ask. And search across a large library has to run on a phone with a fraction of a laptop's memory.

- **Migrations** become a protocol, not a script.
- **Authorization** moves into the data, as signed operations.
- **Indexes** are built incrementally on each device.

## Where it goes next

Expect the line between "app" and "document" to blur. A shared plan, a reading list or a design file are all just documents with many authors, and the network is the least interesting part.

## Highlights

> Your data lives on your device, the network is an optimization, and the cloud is a place to meet, not a place to rent.

Use as the opening line of the talk.

> Migrations become a protocol, not a script.

> The best sync engine is the one you never notice.
`;

const COLORS = ['orange', 'blue', 'green', 'purple', 'pink', 'yellow', 'red', 'brown', 'gray', 'default'];
function stats() {
  const count = (fn) => ITEMS.filter(fn).length;
  const facet = (vals, scale) => {
    const m = new Map();
    for (const v of vals) m.set(v, (m.get(v) || 0) + 1);
    return [...m].map(([name, n], i) => ({ name, color: COLORS[i % COLORS.length], count: n * scale + ((name.length * 7) % 13) }));
  };
  const cols = ['Dev', 'Dev/Architecture', 'Dev/Infra', 'Dev/Databases', 'AI', 'AI/Research', 'AI/Learning', 'Design', 'Work', 'Reading', 'Cooking', 'Travel', 'Notes', 'Podcasts', 'X bookmarks', 'Browser bookmarks', 'Browser bookmarks/Toolbar', 'GitHub stars', 'Pinterest', 'Pinterest/Travel', 'Pinterest/Home', 'Pinterest/Graphic'];
  return {
    total: 3418, library: 2214, x: 1204, unsorted: 12, favorites: 186, unread: 74, notes: 241, highlights: 129, broken: 3, reminders: 2, noTags: 9,
    collections: cols.map((name, i) => ({ name, color: COLORS[i % COLORS.length], count: [64, 38, 41, 27, 18, 52, 33, 147, 88, 112, 23, 46, 241, 39, 1204, 312, 96, 268, 0, 61, 140, 77][i] })),
    tags: facet(ITEMS.flatMap((i) => i.tags), 6).sort((a, b) => b.count - a.count),
    types: facet(ITEMS.map((i) => i.type), 41),
    platforms: facet(ITEMS.map((i) => i.platform).filter(Boolean), 33),
  };
}

function listItems(q) {
  let list = ITEMS;
  const s = q.get('s') || '';
  if (q.get('favorite')) list = list.filter((i) => i.favorite);
  if (q.get('unread')) list = list.filter((i) => !i.read);
  if (q.get('collection') && q.get('collection') !== 'unsorted') list = list.filter((i) => (i.collection || '').startsWith(q.get('collection')));
  if (q.get('type')) list = list.filter((i) => i.type === q.get('type'));
  if (q.get('tag')) list = list.filter((i) => i.tags.includes(q.get('tag')));
  if (q.get('source') === 'x') list = list.filter((i) => i.source === 'X');
  for (const t of (q.get('q') || '').match(/#[\w-]+/g) || []) list = list.filter((i) => i.tags.includes(t.slice(1)));
  const text = (q.get('q') || s).toLowerCase().replace(/#\w+|\w+:\S+/g, '').trim();
  if (text) list = list.filter((i) => `${i.title} ${i.excerpt} ${i.summary} ${i.tags.join(' ')}`.toLowerCase().includes(text));
  return list;
}

// ---------- feeds ----------

const FEEDS = [
  { id: 'f1', url: 'https://inkandswitch.com/feed.xml', title: 'Ink & Switch', site: 'inkandswitch.com', collection: 'Dev/Architecture', autosave: false, added: ago(900), count: 4 },
  { id: 'f2', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=demo', title: 'Interface Club', site: 'youtube.com', collection: 'Design', autosave: true, added: ago(800), count: 3 },
  { id: 'f3', url: 'https://weekly.example.substack.com/feed', title: 'The Systems Weekly', site: 'substack.com', collection: 'Reading', autosave: false, added: ago(700), count: 5 },
  { id: 'f4', url: 'https://type.example.org/rss', title: 'On Type', site: 'type.example.org', collection: 'Design', added: ago(600), count: 2 },
];
const entry = (id, feedId, title, h, summary, n) => {
  const f = FEEDS.find((x) => x.id === feedId);
  return { id, feedId, feed: f.title, title, url: `https://${f.site}/${id}`, date: ago(h), summary, image: n ? C('wide', n) : null, author: '' };
};
const ENTRIES = [
  entry('e1', 'f3', 'Issue 148: queues all the way down', 3, 'Backpressure, retries with jitter and why your queue needs a dead-letter box before it needs Kafka.', 25),
  entry('e2', 'f1', 'Malleable software in practice', 9, 'A year of letting people reshape the tools they use every day, and what broke.', 26),
  entry('e3', 'f2', 'Motion that explains, not decorates', 20, 'Four examples of transitions that make an interface easier to follow.', 27),
  entry('e4', 'f4', 'Variable fonts, five years on', 30, 'Optical sizes, grades for dark mode and the axes nobody uses.', 28),
  entry('e5', 'f3', 'Issue 147: the cost of a cold start', 52, 'Measuring serverless cold starts across five providers, with the numbers.', 29),
  entry('e6', 'f1', 'Notes on collaborative undo', 75, 'Undo is easy until two people edit the same paragraph. Here is a model that works.', 30),
  entry('e7', 'f2', 'Designing empty states people read', 96, 'Copy, illustration and one clear action.', 31),
];

// ---------- shows ----------

const SHOWS = [
  { id: 'sh1', title: 'The Dirt Road Diaries', image: C('square', 12), spotify: { id: 'sp1', title: 'The Dirt Road Diaries' }, youtube: { channelId: 'yt1', title: 'Dirt Road Diaries', playlists: [{ id: 'pl1', title: 'Full episodes', series: null }, { id: 'pl2', title: 'Road Stories', series: 'Road Stories' }], uploads: true }, rules: [], catalog: { at: NOW - 3600e3, episodes: 118, error: null } },
  { id: 'sh2', title: 'Build Notes', image: C('square', 32), spotify: { id: 'sp2', title: 'Build Notes' }, youtube: { channelId: 'yt2', title: 'Build Notes Podcast', playlists: [], uploads: true }, rules: [], catalog: { at: NOW - 7200e3, episodes: 64, error: null } },
  { id: 'sh3', title: 'Slow History', image: C('square', 33), spotify: { id: 'sp3', title: 'Slow History' }, youtube: null, rules: [], catalog: { at: NOW - 9000e3, episodes: 210, error: null } },
];
const card = (id, show, title, series, img, { yt, sp, status, pct, pos, dur, p = 'sp', h = 2, released }) => ({
  id, title, show, series, image: C('square', img), released: released || ago(h * 24 + 200).slice(0, 10),
  yt: yt ? { id: `y${id}`, dur, title } : null, sp: sp ? { id: `s${id}`, dur, title } : null,
  status, pct, finishedAt: status === 'finished' ? NOW - h * 3600e3 : null, doneOn: status === 'finished' ? p : null,
  resume: status === 'started' ? { p, pos, dur, at: NOW - h * 3600e3, src: p === 'sp' ? 'spotify' : 'youtube' } : null,
  last: { p, at: NOW - h * 3600e3 }, updated: ago(h), notionUrl: 'https://www.notion.so/',
});
const CONTINUE = [
  card('c1', 'The Dirt Road Diaries', 'Episode 112: Starting over at forty', null, 12, { yt: 1, sp: 1, status: 'started', pct: 0.38, pos: 1664, dur: 4380, p: 'sp', h: 1 }),
  card('c2', 'Build Notes', '#58 Shipping a database in a weekend (and regretting it)', null, 32, { yt: 1, sp: 1, status: 'started', pct: 0.71, pos: 2350, dur: 3310, p: 'yt', h: 5 }),
  card('c3', 'Slow History', 'The salt roads of the Sahara, part 2', 'Trade Routes', 33, { sp: 1, status: 'started', pct: 0.12, pos: 610, dur: 5100, p: 'sp', h: 26 }),
  card('c4', 'The Dirt Road Diaries', 'Road Stories: a night in Albuquerque', 'Road Stories', 34, { yt: 1, sp: 0, status: 'started', pct: 0.55, pos: 980, dur: 1790, p: 'yt', h: 40 }),
];
const FINISHED = [
  card('d1', 'Build Notes', '#57 What we learned from 1,000 support tickets', null, 32, { yt: 1, sp: 1, status: 'finished', pct: 1, dur: 3020, p: 'sp', h: 20 }),
  card('d2', 'The Dirt Road Diaries', 'Episode 111: The year without a phone', null, 12, { yt: 1, sp: 1, status: 'finished', pct: 1, dur: 4010, p: 'yt', h: 50 }),
  card('d3', 'Slow History', 'The salt roads of the Sahara, part 1', 'Trade Routes', 33, { sp: 1, status: 'finished', pct: 1, dur: 4880, p: 'sp', h: 75 }),
];
function showData(id) {
  const show = SHOWS.find((s) => s.id === id) || SHOWS[0];
  const titles = ['Episode 112: Starting over at forty', 'Road Stories: a night in Albuquerque', 'Episode 111: The year without a phone', 'Episode 110: Learning to sail at sea', 'Road Stories: the diner at mile 88', 'Episode 109: What my grandmother kept', 'Episode 108: Moving to a town of 300', 'Road Stories: snowed in at the pass', 'Episode 107: Fixing the old truck', 'Episode 106: A letter to my younger self'];
  const episodes = titles.map((t, i) => {
    const series = t.startsWith('Road Stories') ? 'Road Stories' : null;
    const c = [...CONTINUE, ...FINISHED].find((x) => x.title.includes(t.split(': ')[1] || t));
    const dur = series ? 1500 + i * 60 : 3800 + i * 90;
    return { key: `r${i}`, title: t, date: ago(i * 24 * 7 + 30).slice(0, 10), dur, series, image: show.image, sp: series && i % 2 ? null : { id: `s${i}`, dur, title: t }, yt: { id: `y${i}`, dur, title: t }, pairedBy: 'catalog', card: c || (i > 6 ? card(`x${i}`, show.title, t, series, 12, { yt: 1, sp: 1, status: 'finished', pct: 1, dur, h: 300 + i }) : null) };
  });
  return { show, catalog: { at: NOW - 3600e3, error: null, spotify: 112, youtube: 118, paired: 109 }, series: [{ name: 'Road Stories', count: 24, finished: 9, started: 1 }], episodes };
}

const side = (user) => ({ connected: true, at: NOW - 40 * 60e3, ok: true, error: null, needsSignIn: false, user });

// ---------- routes ----------

function route(method, path, q, body) {
  if (path === '/api/stats') return stats();
  if (path === '/api/items' && method === 'POST') return { item: { ...ITEMS[0], tags: [...new Set([...ITEMS[0].tags, ...((body && body.tags) || [])])] }, created: true };
  if (path === '/api/items' && method === 'GET') return { items: listItems(q), cursor: null };
  if (path === '/api/search') {
    const query = (q.get('q') || '').toLowerCase();
    const pick = query.includes('sync') || query.includes('offline') ? ['demo-1', 'demo-5', 'demo-18', 'demo-11'] : ITEMS.slice(0, 8).map((i) => i.id);
    return { items: pick.map((id) => ITEMS.find((i) => i.id === id)).filter(Boolean), mode: 'hybrid' };
  }
  let m;
  if ((m = /^\/api\/items\/([^/]+)\/related$/.exec(path))) return { items: ITEMS.filter((i) => ['demo-5', 'demo-18', 'demo-11', 'demo-3', 'demo-7'].includes(i.id)) };
  if ((m = /^\/api\/items\/([^/]+)\/snapshot$/.exec(path))) return { html: true };
  if ((m = /^\/api\/items\/([^/]+)$/.exec(path))) {
    const it = ITEMS.find((i) => i.id === m[1]) || ITEMS[0];
    if (method === 'PATCH') Object.assign(it, body || {});
    return { item: it, markdown: it.id === 'demo-1' ? MARKDOWN : it.excerpt ? `${it.excerpt}\n` : null };
  }
  if (path === '/api/ask')
    return {
      answer: 'Your saves keep coming back to three ideas about offline sync:\n\n1. **Keep data on the device first** and treat the network as an optimization. The Ink & Switch essay calls the cloud “a place to meet, not a place to rent” [1].\n2. **Use CRDTs so edits merge without conflict dialogs.** sync-kit does this in 6 kB with persisters for SQLite and IndexedDB [2].\n3. **Plan migrations as a protocol**, because old and new clients run side by side [1]. The Postgres index guide is useful for the server half [3].',
      sources: ['demo-1', 'demo-5', 'demo-11'].map((id) => ITEMS.find((i) => i.id === id)),
    };
  if (path === '/api/feeds') return { feeds: FEEDS, entries: q.get('feed') ? ENTRIES.filter((e) => e.feedId === q.get('feed')) : ENTRIES };
  if (path === '/api/media/shows' && method === 'GET') return { shows: SHOWS, continue: CONTINUE, finished: FINISHED };
  if ((m = /^\/api\/media\/shows\/([^/]+)$/.exec(path))) return q.get('playlists') ? { playlists: [] } : showData(m[1]);
  if (path === '/api/media/connect') return { spotify: side('Alex Rivera'), youtube: side('Alex Rivera'), shows: SHOWS.length };
  if (path === '/api/media/sync') return { spotify: {}, youtube: {}, updated: 0 };
  if (path === '/api/me')
    return {
      publicUrl: 'https://trove.example.com',
      notion: { library: 'https://www.notion.so/demo' },
      apiKeys: [{ name: 'Claude', key: 'trv_demo_••••••••••••••••' }, { name: 'Shortcuts', key: 'trv_demo_••••••••••••••••' }, { name: 'Telegram', key: 'trv_demo_••••••••••••••••' }],
      cron: true,
      telegram: { configured: true, bot: 'my_trove_bot' },
      email: { configured: true, address: 'save@in.example.com' },
      ai: { enabled: true, paused: null, models: { text: '@cf/qwen/qwen3-30b-a3b-fp8', vision: '@cf/meta/llama-4-scout-17b-16e-instruct', embed: '@cf/baai/bge-m3' } },
      storage: true,
      backup: 'example/trove-backup',
    };
  if (path === '/api/github') return { config: { user: 'alexrivera', token: true }, state: { synced: 268, lastRun: ago(3), lastError: null, backfillDone: true } };
  // The local agent bridge (127.0.0.1:7878).
  if (path === '/run')
    return [
      { type: 'session', id: 'demo' },
      { type: 'tool', label: 'trove search \'collection:"Design" -has:tags\' --json' },
      { type: 'tool', label: 'trove update demo-23 --add-tags color,dark-mode' },
      { type: 'tool', label: 'trove update demo-10 --add-tags typography,reading' },
      { type: 'tool', label: 'trove tags merge ui-design ui' },
      { type: 'text', text: 'Done. I tagged **14 items** in Design that had no tags, reusing tags you already have (`color`, `typography`, `motion`, `ui`), and merged **#ui-design into #ui** (23 items).' },
      { type: 'text', text: 'Two items were too vague to tag with confidence, so I left them in **Untagged**: a Figma link with no title and an image with no text.' },
    ];
  if (path === '/health') return { ok: true, busy: false, engines: { claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: false } } };
  return {};
}

const SNAPSHOT = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:17px/1.65 Georgia,serif;max-width:680px;margin:40px auto;padding:0 20px;color:#222;background:#fffdf8}h1{font:700 34px/1.15 system-ui;letter-spacing:-.02em}.by{color:#777;font:14px system-ui}nav{font:600 14px system-ui;display:flex;gap:18px;border-bottom:1px solid #eee;padding:0 0 14px;margin-bottom:28px}img{width:100%;border-radius:8px}</style></head><body><nav><span>Ink &amp; Switch</span><span style="color:#999">Essays</span><span style="color:#999">Projects</span></nav><h1>The quiet comeback of local-first software</h1><p class="by">Lena Okafor · November 2026</p><img src="/demo-cover/wide-3.svg"><p>Ten years after the first local-first manifesto, sync engines have finally caught up with the idea. The promise was simple: your data lives on your device, the network is an optimization, and the cloud is a place to meet, not a place to rent.</p><p>Three things moved at once. CRDT libraries got small and fast enough to ship in a web page…</p></body></html>`;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cors = { 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-allow-private-network': 'true' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (url.pathname.startsWith('/demo-cover/')) {
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600', ...cors });
    return res.end(cover(url.pathname.slice(12).replace(/\.svg$/, '')));
  }
  if (/\/snapshot$/.test(url.pathname)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cors });
    return res.end(SNAPSHOT);
  }
  let body = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || 'null');
    } catch { /* not JSON */ }
  }
  const out = route(req.method, url.pathname, url.searchParams, body);
  if (url.pathname === '/run') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson', ...cors });
    return res.end(out.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors });
  res.end(JSON.stringify(out));
}).listen(PORT, '127.0.0.1', () => console.log(`Trove demo API on http://127.0.0.1:${PORT}`));
