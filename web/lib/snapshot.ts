// Web archive: a self-contained copy of a page (HTML with its stylesheets and images inlined,
// scripts removed) stored with the item in Notion, plus a Wayback Machine capture. Either one
// keeps the page readable after the original disappears.
import 'server-only';
import { parseHTML } from 'linkedom';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MAX_HTML = 6_000_000;
const MAX_CSS = 1_500_000;
const MAX_IMAGE = 2_500_000;
const MAX_TOTAL = 16_000_000;

async function fetchWithin(url: string, ms: number, accept: string) {
  return fetch(url, { headers: { 'user-agent': UA, accept, 'accept-language': 'en,es;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
}

async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) {
    res.body?.cancel().catch(() => {});
    return null;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length > max ? null : buf;
}

const abs = (u: string, base: string) => {
  try {
    return new URL(u.trim(), base).href;
  } catch {
    return null;
  }
};

function rewriteCssUrls(css: string, base: string) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => (/^(data:|#)/.test(u) ? m : `url("${abs(u, base) || u}")`));
}

/** Biggest reasonable candidate from a srcset (prefers ~1200w). */
function pickSrcset(srcset: string): string | null {
  const cands = srcset
    .split(/,\s+(?=\S)/)
    .map((c) => {
      const [u, d] = c.trim().split(/\s+/);
      const w = d?.endsWith('w') ? parseInt(d) : d?.endsWith('x') ? parseFloat(d) * 1000 : 1000;
      return { u, w: Number.isFinite(w) ? w : 1000 };
    })
    .filter((c) => c.u);
  if (!cands.length) return null;
  cands.sort((a, b) => Math.abs(a.w - 1200) - Math.abs(b.w - 1200));
  return cands[0].u;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Build a self-contained HTML snapshot of a page. Returns null when the page can't be fetched
 * or isn't HTML. Pass `html` to snapshot markup you already have (e.g. sent by the extension).
 */
export async function buildSnapshot(url: string, given?: string): Promise<Uint8Array | null> {
  let html = given || '';
  let base = url;
  if (!html) {
    let res: Response;
    try {
      res = await fetchWithin(url, 20000, 'text/html,application/xhtml+xml');
    } catch {
      return null;
    }
    if (!res.ok || !/html|xml/i.test(res.headers.get('content-type') || '')) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    base = res.url || url;
    const bytes = await readCapped(res, MAX_HTML);
    if (!bytes) return null;
    html = new TextDecoder().decode(bytes);
  }
  const { document } = parseHTML(html);
  if (!document.documentElement) return null;
  const docBase = document.querySelector('base[href]')?.getAttribute('href');
  if (docBase) base = abs(docBase, base) || base;

  // Remove everything that runs code or reloads the page; unwrap <noscript> image fallbacks.
  for (const el of document.querySelectorAll('noscript')) {
    const inner = el.textContent || '';
    if (/<img/i.test(inner)) el.outerHTML = inner;
    else el.remove();
  }
  for (const el of document.querySelectorAll('script, iframe, frame, frameset, object, embed, applet, base, meta[http-equiv], link[rel~="preload"], link[rel~="modulepreload"], link[rel~="prefetch"], link[rel~="dns-prefetch"], link[rel~="preconnect"], link[rel="manifest"], template')) el.remove();
  for (const el of document.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src|action|formaction)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
  }

  let total = 0;
  const budget = (n: number) => (total + n <= MAX_TOTAL ? ((total += n), true) : false);

  // Stylesheets inline.
  const sheets = [...document.querySelectorAll('link[rel~="stylesheet"][href]')].slice(0, 20);
  await Promise.all(
    sheets.map(async (link: any) => {
      const href = abs(link.getAttribute('href') || '', base);
      if (!href) return link.remove();
      try {
        const res = await fetchWithin(href, 10000, 'text/css');
        const bytes = res.ok ? await readCapped(res, MAX_CSS) : null;
        if (!bytes || !budget(bytes.length)) return link.remove();
        const style = document.createElement('style');
        const media = link.getAttribute('media');
        if (media) style.setAttribute('media', media);
        style.textContent = rewriteCssUrls(new TextDecoder().decode(bytes), href);
        link.replaceWith(style);
      } catch {
        link.remove();
      }
    }),
  );
  for (const style of document.querySelectorAll('style')) style.textContent = rewriteCssUrls(style.textContent || '', base);
  for (const el of document.querySelectorAll('[style]')) el.setAttribute('style', rewriteCssUrls(el.getAttribute('style') || '', base));

  // Images inline (lazy-loading attributes resolved first).
  const imgs = [...document.querySelectorAll('img, picture source, video[poster], input[type="image"]')];
  const jobs: { el: any; attr: string; url: string }[] = [];
  for (const el of imgs as any[]) {
    if (el.tagName === 'VIDEO') {
      const u = abs(el.getAttribute('poster') || '', base);
      if (u) jobs.push({ el, attr: 'poster', url: u });
      continue;
    }
    const srcset = el.getAttribute('data-srcset') || el.getAttribute('srcset') || '';
    const raw = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original') || (srcset && pickSrcset(srcset)) || el.getAttribute('src') || '';
    el.removeAttribute('srcset');
    el.removeAttribute('data-srcset');
    el.removeAttribute('loading');
    if (el.tagName === 'SOURCE') {
      el.remove();
      continue;
    }
    if (!raw || raw.startsWith('data:')) continue;
    const u = abs(raw, base);
    if (u) jobs.push({ el, attr: 'src', url: u });
  }
  const seen = new Map<string, string | null>();
  let next = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < Math.min(jobs.length, 80)) {
        const j = jobs[next++];
        if (!seen.has(j.url)) {
          let data: string | null = null;
          try {
            const res = await fetchWithin(j.url, 10000, 'image/avif,image/webp,image/*');
            const type = res.headers.get('content-type') || '';
            const bytes = res.ok && type.startsWith('image/') ? await readCapped(res, MAX_IMAGE) : null;
            if (bytes && budget(bytes.length * 1.37)) data = `data:${type.split(';')[0]};base64,${Buffer.from(bytes).toString('base64')}`;
          } catch { /* keep the remote URL */ }
          seen.set(j.url, data);
        }
        j.el.setAttribute(j.attr, seen.get(j.url) || j.url);
      }
    }),
  );

  // Links point at the original site; mark the copy.
  for (const a of document.querySelectorAll('a[href]') as any) {
    const u = abs(a.getAttribute('href') || '', base);
    if (u) a.setAttribute('href', u);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noreferrer noopener');
  }
  const head = document.head || document.documentElement;
  const meta = document.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  head.prepend(meta);
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const banner = document.createElement('div');
  banner.setAttribute('style', 'all:initial;display:block;position:sticky;top:0;z-index:2147483647;background:#1f1b16;color:#f6f3ee;font:13px/1.4 -apple-system,system-ui,sans-serif;padding:7px 12px;text-align:center');
  banner.innerHTML = `Archived by Trove on ${esc(when)} UTC · <a href="${esc(url)}" target="_blank" rel="noreferrer" style="color:#f0b37e">${esc(url.replace(/^https?:\/\//, '').slice(0, 90))}</a>`;
  (document.body || document.documentElement).prepend(banner);

  const out = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
  return new TextEncoder().encode(out);
}

/**
 * Ask the Wayback Machine to capture a page (Save Page Now). Returns the snapshot URL, or null
 * when the archive is busy or refuses the page. Anonymous captures are rate limited, so this is
 * best-effort.
 */
export async function waybackSave(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://web.archive.org/save/${url}`, { headers: { 'user-agent': 'Trove (personal archive)' }, redirect: 'manual', signal: AbortSignal.timeout(45000) });
    res.body?.cancel().catch(() => {});
    const loc = res.headers.get('location') || res.headers.get('content-location') || '';
    const m = /\/web\/(\d{14})/.exec(loc);
    if (m) return `https://web.archive.org/web/${m[1]}/${url}`;
    if (res.status >= 200 && res.status < 400) return `https://web.archive.org/web/2/${url}`;
  } catch { /* best effort */ }
  return waybackLatest(url);
}

/** The newest existing Wayback capture of a URL, if any. */
export async function waybackLatest(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(15000) });
    const j: any = await res.json();
    const snap = j?.archived_snapshots?.closest;
    return snap?.available && snap.url ? String(snap.url).replace(/^http:/, 'https:') : null;
  } catch {
    return null;
  }
}
