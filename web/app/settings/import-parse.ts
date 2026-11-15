// Import parsers for Settings → Data → Import. Run in the browser (DOMParser).

export type ImportRow = { url: string; title?: string; collection?: string; tags?: string[]; note?: string; source?: string };

function parseNetscape(html: string): ImportRow[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: ImportRow[] = [];
  const skip = /^(bookmarks bar|bookmarks toolbar|barra de marcadores|favorites bar|other bookmarks|otros marcadores|mobile bookmarks|bookmarks menu)$/i;
  const walk = (dl: Element, path: string[]) => {
    for (const dt of Array.from(dl.children)) {
      if (dt.tagName !== 'DT') continue;
      const a = dt.querySelector(':scope > a');
      const h3 = dt.querySelector(':scope > h3');
      if (a) {
        const url = a.getAttribute('href') || '';
        if (/^https?:/.test(url)) out.push({ url, title: a.textContent?.trim(), collection: ['Browser bookmarks', ...path].join('/'), tags: (a.getAttribute('tags') || '').split(',').map((s) => s.trim()).filter(Boolean), source: 'Browser bookmarks' });
      } else if (h3) {
        const sub = dt.querySelector(':scope > dl');
        const name = h3.textContent?.trim() || '';
        if (sub) walk(sub, skip.test(name) ? path : [...path, name]);
      }
    }
  };
  const root = doc.querySelector('dl');
  if (root) walk(root, []);
  return out;
}

function parseCsv(text: string): ImportRow[] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      cur.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      cur.push(cell);
      rows.push(cur);
      cur = [];
      cell = '';
    } else cell += c;
  }
  if (cell || cur.length) rows.push([...cur, cell]);
  const [head, ...body] = rows.filter((r) => r.some(Boolean));
  const idx = (names: string[]) => head.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const u = idx(['url', 'link', 'href']);
  const t = idx(['title', 'name']);
  const f = idx(['folder', 'collection']);
  const g = idx(['tags']);
  const n = idx(['note', 'notes', 'description', 'excerpt']);
  return body
    .map((r) => ({ url: r[u], title: r[t], collection: r[f] || undefined, tags: (r[g] || '').split(/[,|]/).map((s) => s.trim()).filter(Boolean), note: r[n] || undefined }))
    .filter((r) => /^https?:/.test(r.url || ''));
}

/** Links from a browser bookmarks export (HTML), a Raindrop/Pocket CSV, a Trove JSON export or any text with links. */
export function parseFile(name: string, text: string): ImportRow[] {
  if (/\.html?$/i.test(name) || /<!DOCTYPE NETSCAPE/i.test(text)) return parseNetscape(text);
  if (/\.csv$/i.test(name)) return parseCsv(text);
  if (/\.json$/i.test(name)) {
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : j.items || [];
    return list.map((x: any) => ({ url: x.url || x.link, title: x.title, collection: x.collection || x.folder, tags: x.tags, note: x.note })).filter((r: ImportRow) => /^https?:/.test(r.url || ''));
  }
  return (text.match(/https?:\/\/[^\s<>"']+/g) || []).map((url) => ({ url }));
}
