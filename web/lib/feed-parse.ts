// RSS / Atom parsing (pure, testable).
import { DOMParser, parseHTML } from 'linkedom';

const text = (el: any) => (el?.textContent || '').trim();
const strip = (html: string) => {
  if (!/[<&]/.test(html)) return html;
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return (document.body?.textContent || '').replace(/\s+/g, ' ').trim();
};
const firstImage = (html: string) => /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1] || null;

export function parseFeed(xml: string, base: string) {
  const doc: any = new DOMParser().parseFromString(xml, 'text/xml');
  const atom = !!doc.querySelector('feed');
  const title = text(doc.querySelector(atom ? 'feed > title' : 'channel > title'));
  const siteEl = atom ? [...doc.querySelectorAll('feed > link')].find((l: any) => (l.getAttribute('rel') || 'alternate') === 'alternate') : doc.querySelector('channel > link');
  const site = atom ? siteEl?.getAttribute('href') || '' : text(siteEl);
  const nodes = [...doc.querySelectorAll(atom ? 'entry' : 'item')].slice(0, 60);
  const entries = nodes.map((n: any) => {
    const linkEl = atom ? [...n.querySelectorAll('link')].find((l: any) => (l.getAttribute('rel') || 'alternate') === 'alternate') || n.querySelector('link') : n.querySelector('link');
    let link = atom ? linkEl?.getAttribute('href') || '' : text(linkEl) || linkEl?.getAttribute?.('href') || '';
    if (!link) link = text(n.querySelector('guid'));
    try {
      link = new URL(link, base).href;
    } catch { /* keep */ }
    const body = text(n.querySelector('content')) || text(n.getElementsByTagName('content:encoded')[0]) || text(n.querySelector('summary')) || text(n.querySelector('description')) || text(n.getElementsByTagName('media:description')[0]);
    const thumb = n.getElementsByTagName('media:thumbnail')[0]?.getAttribute('url') || n.getElementsByTagName('media:content')[0]?.getAttribute('url') || [...n.querySelectorAll('enclosure')].find((e: any) => /^image\//.test(e.getAttribute('type') || ''))?.getAttribute('url') || firstImage(body);
    const date = text(n.querySelector('published')) || text(n.querySelector('updated')) || text(n.querySelector('pubDate')) || text(n.getElementsByTagName('dc:date')[0]);
    const d = date ? new Date(date) : null;
    return {
      title: strip(text(n.querySelector('title'))) || link,
      url: link,
      date: d && !isNaN(d.getTime()) ? d.toISOString() : null,
      summary: strip(body).slice(0, 400),
      image: thumb || null,
      author: text(n.querySelector('author > name')) || text(n.querySelector('author')) || text(n.getElementsByTagName('dc:creator')[0]),
    };
  });
  return { title, site, entries: entries.filter((e: any) => /^https?:/.test(e.url)) };
}

