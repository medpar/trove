#!/usr/bin/env node
// Dev proxy for the Trove iOS app: serves the real library READ-ONLY and simulates every write in memory.
//
//   node ios/DevProxy/proxy.mjs            # http://127.0.0.1:8787
//
// Reads go to the server in ~/.config/trove/config.json (the trove CLI login) with that key, which never
// leaves this process. Edits, deletes, saves, uploads, highlights and feed changes are applied to an
// in-memory overlay only, so testing the app can't change your library. Sign in to the app with
// server http://127.0.0.1:8787 and the test credentials below (test values, valid only for this proxy).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const TEST_KEY = 'trove-dev-key';
const TEST_PASSWORD = 'trove-dev-password';
const TEST_SESSION = 'dev-session';

const cfg = JSON.parse(readFileSync(join(homedir(), '.config/trove/config.json'), 'utf8'));
const UPSTREAM = String(process.env.TROVE_URL || cfg.url).replace(/\/$/, '');
const UPSTREAM_KEY = process.env.TROVE_API_KEY || cfg.key;

const overlay = new Map(); // id -> partial item
const deleted = new Set();
const created = []; // fabricated items, newest first
const extraHighlights = new Map(); // id -> [{text, note}]
let feedPatch = { removed: new Set(), added: [], autosave: new Map() };

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

const authed = (req) => {
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${TEST_KEY}`) return true;
  return (req.headers.cookie || '').split(/;\s*/).includes(`trove_session=${TEST_SESSION}`);
};

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

async function upstream(path, init = {}) {
  const r = await fetch(UPSTREAM + path, { ...init, headers: { authorization: `Bearer ${UPSTREAM_KEY}`, ...(init.headers || {}) } });
  return r;
}

const applyAsk = (d) => ({ ...d, sources: applyList(d.sources || []) });
const applyItem = (it) => (it && overlay.has(it.id) ? { ...it, ...overlay.get(it.id) } : it);
const applyList = (items = []) => items.filter((i) => !deleted.has(i.id)).map(applyItem);

function fabricate({ url, text, title, tags, collection, note, favorite }) {
  const now = new Date().toISOString();
  let domain = '';
  try { domain = url ? new URL(url).hostname.replace(/^www\./, '') : ''; } catch {}
  const item = {
    id: `dev-${randomUUID()}`, db: 'library', url: url || '', title: title || (url ? url.replace(/^https?:\/\//, '') : String(text || '').split('\n')[0].slice(0, 80)) || 'Untitled',
    excerpt: text || '', domain, type: url ? 'Link' : 'Note', platform: url ? 'Web' : 'Note', collection: collection || null,
    tags: Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    cover: null, icon: null, author: '', published: null, created: now, updated: now, favorite: !!favorite, read: false,
    note: note || '', status: null, highlights: 0, readingTime: null, duration: null, remind: null, source: 'iOS app', via: '',
    notionUrl: 'https://www.notion.so', summary: '', progress: null, archive: null, snapshot: false,
  };
  created.unshift(item);
  return item;
}

async function getItem(id) {
  const c = created.find((i) => i.id === id);
  if (c) return { item: applyItem(c), markdown: c.excerpt || '' };
  const r = await upstream(`/api/items/${id}?content=1`);
  if (!r.ok) return null;
  const data = await r.json();
  data.item = applyItem(data.item);
  const extra = extraHighlights.get(id);
  if (extra?.length && data.markdown != null) {
    const has = /^#{1,3}\s+Highlights\s*$/m.test(data.markdown);
    data.markdown += (has ? '\n' : '\n## Highlights\n') + extra.map((h) => `> ${h.text}${h.note ? `\n${h.note}` : ''}`).join('\n');
  }
  return data;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if (path === '/api/auth/login' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    if (body.password !== TEST_PASSWORD) return json(res, 401, { error: 'Wrong password' });
    return json(res, 200, { ok: true }, { 'set-cookie': `trove_session=${TEST_SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` });
  }
  if (!path.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
  if (!authed(req)) return json(res, 401, { error: 'Unauthorized: sign in or pass Authorization: Bearer <api key>' });

  if (path === '/api/me') {
    const r = await upstream('/api/me');
    const me = await r.json();
    me.apiKeys = (req.headers.authorization ? [{ name: 'Dev proxy', key: '' }] : []);
    return json(res, r.status, me);
  }

  let m;
  if ((m = path.match(/^\/api\/items\/([^/]+)$/))) {
    const id = m[1];
    if (method === 'GET') {
      const data = await getItem(id);
      return data ? json(res, 200, data) : json(res, 404, { error: 'Not found' });
    }
    if (method === 'PATCH') {
      const patch = JSON.parse((await readBody(req)).toString() || '{}');
      const current = (await getItem(id))?.item;
      if (!current) return json(res, 404, { error: 'Not found' });
      const next = { ...(overlay.get(id) || {}) };
      for (const k of ['title', 'tags', 'note', 'favorite', 'read', 'remind', 'progress', 'summary']) if (patch[k] !== undefined) next[k] = patch[k];
      if (patch.collection !== undefined) next.collection = patch.collection === '' ? null : patch.collection;
      overlay.set(id, next);
      return json(res, 200, { item: { ...current, ...next } });
    }
    if (method === 'DELETE') {
      deleted.add(id);
      return json(res, 200, { ok: true });
    }
  }

  if ((m = path.match(/^\/api\/items\/([^/]+)\/highlights$/)) && method === 'POST') {
    const id = m[1];
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const list = extraHighlights.get(id) || [];
    list.push({ text: body.text, note: body.note });
    extraHighlights.set(id, list);
    const current = (await getItem(id))?.item;
    const count = (current?.highlights || 0) + 1;
    overlay.set(id, { ...(overlay.get(id) || {}), highlights: count });
    return json(res, 200, { item: { ...current, highlights: count } });
  }

  if (path === '/api/items' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    if (Array.isArray(body.items)) return json(res, 200, { results: body.items.map((b) => ({ item: fabricate(b), created: true })) });
    await new Promise((r) => setTimeout(r, 500));
    return json(res, 201, { item: fabricate(body), created: true });
  }

  if (path === '/api/files' && method === 'POST') {
    const raw = await readBody(req);
    const type = req.headers['content-type'] || '';
    let fields = {};
    if (type.includes('application/json')) fields = JSON.parse(raw.toString() || '{}');
    else {
      for (const name of ['title', 'note', 'tags', 'collection']) {
        const mm = raw.toString('latin1').match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`));
        if (mm) fields[name] = mm[1];
      }
      const fn = raw.toString('latin1').match(/filename="([^"]+)"/);
      fields.title = fields.title || fn?.[1] || 'Upload';
    }
    const item = fabricate({ ...fields, text: '' });
    Object.assign(item, { type: 'Image', platform: 'Upload' });
    return json(res, 201, { item, created: true });
  }

  if (path === '/api/files/uploads' && method === 'POST') {
    await readBody(req);
    return json(res, 200, { upload: 'dev-upload', put: { method: 'PUT', url: `http://127.0.0.1:${PORT}/dev-blob`, headers: {} } });
  }

  if (path === '/api/enrich' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const data = await getItem(body.id);
    return json(res, 200, { item: data?.item, skipped: ['simulated by the dev proxy'], errors: [] });
  }

  if (path === '/api/feeds') {
    if (method === 'GET') {
      const r = await upstream(`/api/feeds${url.search}`);
      const data = await r.json();
      data.feeds = [...(data.feeds || []).filter((f) => !feedPatch.removed.has(f.id)), ...feedPatch.added].map((f) => (feedPatch.autosave.has(f.id) ? { ...f, autosave: feedPatch.autosave.get(f.id) } : f));
      return json(res, r.status, data);
    }
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    if (method === 'POST') {
      const feed = { id: randomUUID().slice(0, 12), url: body.url, title: body.url.replace(/^https?:\/\//, ''), site: body.url, collection: body.collection || null, autosave: !!body.autosave, added: new Date().toISOString() };
      feedPatch.added.push(feed);
      return json(res, 201, { feed });
    }
    if (method === 'PATCH') {
      if (typeof body.autosave === 'boolean') feedPatch.autosave.set(body.id, body.autosave);
      return json(res, 200, { feed: { id: body.id, url: '', title: '', autosave: body.autosave } });
    }
    if (method === 'DELETE') {
      feedPatch.removed.add(url.searchParams.get('id'));
      return json(res, 200, { ok: true });
    }
  }

  if (method === 'PUT' && path === '/dev-blob') {
    await readBody(req);
    return json(res, 200, {});
  }

  // Ask: when the server's AI is unavailable (e.g. its free daily allowance is used up), answer with a
  // clearly marked sample built from real search results, so the app's answer layout can still be checked.
  if (path === '/api/ask' && method === 'POST' && process.env.MOCK_ASK !== '0') {
    const raw = await readBody(req);
    const r = await upstream(path, { method, body: raw, headers: { 'content-type': 'application/json' } });
    if (r.ok) return json(res, 200, applyAsk(await r.json()));
    const q = JSON.parse(raw.toString() || '{}').question || '';
    const s = await (await upstream(`/api/search?q=${encodeURIComponent(q)}&limit=4`)).json().catch(() => ({ items: [] }));
    const sources = applyList(s.items || []).slice(0, 4);
    const lines = sources.map((it, i) => `- **${it.title}**: ${(it.summary || it.excerpt || '').replace(/\s+/g, ' ').slice(0, 140)} [${i + 1}]`);
    const answer = `*(Sample answer from the dev proxy: the server's AI is unavailable right now.)*\n\nHere's what your library has on that:\n\n${lines.join('\n')}\n\nThe most relevant one is probably the first [1].`;
    return json(res, 200, { answer, sources });
  }

  // Everything else that only reads: forward, then apply the overlay.
  if (method === 'GET' || path === '/api/ask') {
    const init = method === 'GET' ? {} : { method, body: await readBody(req), headers: { 'content-type': req.headers['content-type'] || 'application/json' } };
    const r = await upstream(path + url.search, init);
    const type = r.headers.get('content-type') || '';
    if (!type.includes('json')) {
      res.writeHead(r.status, { 'content-type': type });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    const data = await r.json();
    if (Array.isArray(data.items)) data.items = applyList(data.items);
    if (Array.isArray(data.sources)) data.sources = applyList(data.sources);
    if (path === '/api/items' && !url.searchParams.get('cursor') && !url.searchParams.get('q') && [...url.searchParams.keys()].every((k) => ['sort', 'limit'].includes(k))) {
      data.items = [...created.map(applyItem).filter((i) => !deleted.has(i.id)), ...data.items];
    }
    return json(res, r.status, data);
  }

  return json(res, 405, { error: `${method} ${path} is not simulated by the dev proxy` });
}

createServer(async (req, res) => {
  const t = Date.now();
  try {
    await handle(req, res);
  } catch (e) {
    json(res, 502, { error: `Dev proxy: ${e.message}` });
  }
  console.log(`${req.method} ${req.url.slice(0, 120)} -> ${res.statusCode} ${Date.now() - t}ms`);
}).listen(PORT, '127.0.0.1', () => console.log(`Trove dev proxy on http://127.0.0.1:${PORT} (reads from ${new URL(UPSTREAM).host}, writes simulated)`));
