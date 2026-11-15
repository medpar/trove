// An in-memory Notion (data sources, pages, queries with the filters Trove uses) for end-to-end tests.
export function fakeNotion(schema = {}) {
  const pages = new Map();
  let n = 0;
  let clock = Date.parse('2026-11-15T10:00:00.000Z');
  const now = () => new Date((clock += 60_000)).toISOString();
  const props = Object.fromEntries(Object.entries(schema).map(([name, def]) => [name, { id: name, name, type: Object.keys(def)[0], ...def }]));
  const calls = { create: 0, update: 0, query: 0 };

  const rich = (arr) => (arr || []).map((t) => ({ type: 'text', text: t.text, plain_text: t.text?.content ?? '' }));
  function toOut(input, prev = {}) {
    const out = { ...prev };
    for (const [name, v] of Object.entries(input || {})) {
      const type = props[name]?.type || Object.keys(v)[0];
      if (type === 'title') out[name] = { type, title: rich(v.title) };
      else if (type === 'rich_text') out[name] = { type, rich_text: rich(v.rich_text) };
      else out[name] = { type, [type]: v[type] ?? null };
    }
    return out;
  }
  const text = (p) => (p?.rich_text || p?.title || []).map((t) => t.plain_text).join('');

  function match(page, f) {
    if (!f) return true;
    if (f.or) return f.or.some((x) => match(page, x));
    if (f.and) return f.and.every((x) => match(page, x));
    if (f.timestamp === 'last_edited_time') return page.last_edited_time >= f.last_edited_time.on_or_after;
    const p = page.properties[f.property];
    if (f.rich_text) return text(p) === f.rich_text.equals;
    if (f.select) return (p?.select?.name || null) === f.select.equals;
    throw new Error(`fake notion: unsupported filter ${JSON.stringify(f)}`);
  }

  function sortValue(page, s) {
    if (s.timestamp) return page[s.timestamp];
    const p = page.properties[s.property];
    return p?.date?.start || p?.number || '';
  }

  async function handle(method, path, body) {
    let m;
    if ((m = /^\/v1\/data_sources\/([^/]+)$/.exec(path))) {
      if (method === 'PATCH') for (const [k, v] of Object.entries(body.properties || {})) props[k] = { id: k, name: k, type: Object.keys(v)[0], ...v };
      return { object: 'data_source', id: m[1], properties: props, parent: { database_id: 'db-1' } };
    }
    if ((m = /^\/v1\/data_sources\/([^/]+)\/query$/.exec(path))) {
      calls.query++;
      let list = [...pages.values()].filter((p) => !p.in_trash && match(p, body.filter));
      for (const s of [...(body.sorts || [])].reverse()) {
        list.sort((a, b) => {
          const x = sortValue(a, s);
          const y = sortValue(b, s);
          return (x < y ? -1 : x > y ? 1 : 0) * (s.direction === 'descending' ? -1 : 1);
        });
      }
      const start = Number(body.start_cursor || 0);
      const size = body.page_size || 100;
      const slice = list.slice(start, start + size);
      return { results: slice, has_more: start + size < list.length, next_cursor: start + size < list.length ? String(start + size) : null };
    }
    if (path === '/v1/pages' && method === 'POST') {
      calls.create++;
      const id = `page-${++n}`;
      const t = now();
      const page = { object: 'page', id, url: `https://notion.so/${id}`, created_time: t, last_edited_time: t, in_trash: false, cover: body.cover || null, icon: body.icon || null, properties: toOut(body.properties) };
      pages.set(id, page);
      return page;
    }
    if ((m = /^\/v1\/pages\/([^/]+)$/.exec(path))) {
      const page = pages.get(m[1]);
      if (!page) return { status: 404, body: { object: 'error', code: 'object_not_found', message: 'nope' } };
      if (method === 'PATCH') {
        calls.update++;
        if (body.in_trash !== undefined) page.in_trash = body.in_trash;
        if (body.properties) page.properties = toOut(body.properties, page.properties);
        if (body.cover) page.cover = body.cover;
        page.last_edited_time = now();
      }
      return page;
    }
    throw new Error(`fake notion: ${method} ${path}`);
  }

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    if (u.hostname !== 'api.notion.com') throw new Error(`unexpected fetch ${url}`);
    const r = await handle(init.method || 'GET', u.pathname, init.body ? JSON.parse(init.body) : {});
    const status = r?.status && r.body ? r.status : 200;
    return new Response(JSON.stringify(r?.status && r.body ? r.body : r), { status, headers: { 'content-type': 'application/json' } });
  }

  /** Edit a page "by hand in Notion". */
  function edit(id, properties) {
    const page = pages.get(id);
    page.properties = toOut(properties, page.properties);
    page.last_edited_time = now();
  }

  return { fetch: fetchImpl, pages, calls, edit, live: () => [...pages.values()].filter((p) => !p.in_trash) };
}
