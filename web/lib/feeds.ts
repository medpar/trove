// RSS / Atom feeds and newsletters with a feed. Subscriptions live in Blob state; entries are
// read live (cached for a few minutes) and shown in the Feeds view, so nothing reaches the
// library until you save it, unless a feed is set to auto-save into a collection.
import 'server-only';
import { createHash } from 'node:crypto';
import { DOMParser, parseHTML } from 'linkedom';
import { parseFeed } from './feed-parse';
import { save } from './store';
import { readState, writeState } from './state';

export type Feed = { id: string; url: string; title: string; site: string; collection?: string | null; autosave?: boolean; added: string; seen?: string | null; error?: string | null };
export type Entry = { id: string; feedId: string; feed: string; title: string; url: string; date: string | null; summary: string; image: string | null; author: string };

const UA = 'Mozilla/5.0 (compatible; Trove feed reader; +https://github.com/medpar/trove)';
const idOf = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);

export async function getFeeds(): Promise<Feed[]> {
  return (await readState<{ feeds: Feed[] }>('feeds.json'))?.feeds || [];
}

async function putFeeds(feeds: Feed[]) {
  await writeState('feeds.json', { feeds });
  cache.clear();
}

async function fetchText(url: string) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return { text: await res.text(), url: res.url || url, type: res.headers.get('content-type') || '' };
}

const looksLikeFeed = (text: string) => /<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 2000));

/** Find the feed for a page or accept a feed URL; knows YouTube channels, Substack, Medium and Reddit. */
export async function discover(input: string): Promise<{ url: string; title: string; site: string }> {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const u = new URL(url);
  if (/(^|\.)reddit\.com$/.test(u.hostname) && !u.pathname.endsWith('.rss')) url = `${u.origin}${u.pathname.replace(/\/$/, '')}/.rss`;
  if (/(^|\.)medium\.com$/.test(u.hostname) && !u.pathname.startsWith('/feed')) url = `${u.origin}/feed${u.pathname}`;
  const got = await fetchText(url);
  if (looksLikeFeed(got.text)) {
    const parsed = parseFeed(got.text, got.url);
    return { url: got.url, title: parsed.title || u.hostname, site: parsed.site || u.origin };
  }
  const { document } = parseHTML(got.text);
  const alt = [...document.querySelectorAll('link[rel="alternate"]')].find((l: any) => /rss|atom|xml/i.test(l.getAttribute('type') || ''));
  let feedUrl = alt ? new URL(alt.getAttribute('href') || '', got.url).href : null;
  if (!feedUrl && /youtube\.com$/.test(u.hostname)) {
    const cid = /"channelId":"(UC[\w-]{22})"/.exec(got.text)?.[1] || /channel\/(UC[\w-]{22})/.exec(url)?.[1];
    if (cid) feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`;
  }
  if (!feedUrl && /substack\.com$/.test(u.hostname)) feedUrl = `${u.origin}/feed`;
  if (!feedUrl) {
    for (const guess of ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml']) {
      try {
        const g = await fetchText(new URL(guess, got.url).href);
        if (looksLikeFeed(g.text)) {
          feedUrl = g.url;
          break;
        }
      } catch { /* next */ }
    }
  }
  if (!feedUrl) throw new Error('No RSS or Atom feed found on that page');
  const f = await fetchText(feedUrl);
  const parsed = parseFeed(f.text, f.url);
  return { url: f.url, title: parsed.title || document.querySelector('title')?.textContent?.trim() || u.hostname, site: parsed.site || u.origin };
}

const cache = new Map<string, { at: number; entries: Entry[]; error?: string }>();

async function entriesOf(f: Feed, maxAge = 15 * 60e3): Promise<{ entries: Entry[]; error?: string }> {
  const c = cache.get(f.id);
  if (c && Date.now() - c.at < maxAge) return c;
  try {
    const got = await fetchText(f.url);
    const parsed = parseFeed(got.text, got.url);
    const entries = parsed.entries.map((e) => ({ ...e, id: idOf(e.url), feedId: f.id, feed: f.title }));
    const v = { at: Date.now(), entries };
    cache.set(f.id, v);
    return v;
  } catch (e: any) {
    const v = { at: Date.now(), entries: c?.entries || [], error: e?.message || String(e) };
    cache.set(f.id, v);
    return v;
  }
}

/** Latest entries across feeds (or one feed), newest first. */
export async function readEntries(feedId?: string, limit = 120) {
  const feeds = (await getFeeds()).filter((f) => !feedId || f.id === feedId);
  const results = await Promise.all(feeds.map((f) => entriesOf(f)));
  const entries = results.flatMap((r) => r.entries);
  entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const errors = Object.fromEntries(feeds.map((f, i) => [f.id, results[i].error || null]));
  return { feeds: feeds.map((f) => ({ ...f, error: errors[f.id], count: results[feeds.indexOf(f)].entries.length })), entries: entries.slice(0, limit) };
}

export async function subscribe(url: string, opts: { collection?: string | null; autosave?: boolean } = {}) {
  const found = await discover(url);
  const feeds = await getFeeds();
  const existing = feeds.find((f) => f.url === found.url);
  if (existing) return existing;
  const feed: Feed = { id: idOf(found.url), url: found.url, title: found.title.slice(0, 120), site: found.site, collection: opts.collection || null, autosave: !!opts.autosave, added: new Date().toISOString(), seen: new Date().toISOString() };
  await putFeeds([...feeds, feed]);
  return feed;
}

export async function updateFeed(id: string, patch: Partial<Pick<Feed, 'title' | 'collection' | 'autosave'>>) {
  const feeds = await getFeeds();
  const f = feeds.find((x) => x.id === id);
  if (!f) throw Object.assign(new Error('Unknown feed'), { status: 404 });
  Object.assign(f, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  await putFeeds(feeds);
  return f;
}

export async function unsubscribe(id: string) {
  await putFeeds((await getFeeds()).filter((f) => f.id !== id));
}

/** OPML import: subscribe to every feed in the file (without auto-save). */
export async function importOpml(xml: string) {
  const doc: any = new DOMParser().parseFromString(xml, 'text/xml');
  const outlines = [...doc.querySelectorAll('outline[xmlUrl]')];
  const feeds = await getFeeds();
  const have = new Set(feeds.map((f) => f.url));
  let added = 0;
  for (const o of outlines as any[]) {
    const url = o.getAttribute('xmlUrl');
    if (!url || have.has(url)) continue;
    feeds.push({ id: idOf(url), url, title: (o.getAttribute('title') || o.getAttribute('text') || url).slice(0, 120), site: o.getAttribute('htmlUrl') || '', added: new Date().toISOString(), seen: new Date().toISOString() });
    have.add(url);
    added++;
  }
  if (added) await putFeeds(feeds);
  return { added, total: feeds.length };
}

/** Save new entries of auto-save feeds into their collection (daily cron). */
export async function autosaveFeeds(maxPerFeed = 15) {
  const feeds = await getFeeds();
  let saved = 0;
  const errors: string[] = [];
  let changed = false;
  for (const f of feeds.filter((x) => x.autosave)) {
    const { entries, error } = await entriesOf(f, 0);
    if (error) {
      errors.push(`${f.title}: ${error}`);
      continue;
    }
    const since = f.seen || f.added;
    const fresh = entries.filter((e) => e.date && e.date > since).slice(0, maxPerFeed);
    for (const e of fresh.reverse()) {
      try {
        await save({ url: e.url, title: e.title, collection: f.collection || `Feeds/${f.title}`, source: 'Feed', via: f.title });
        saved++;
      } catch (err: any) {
        errors.push(`${e.url}: ${err?.message || err}`);
      }
    }
    const newest = entries.map((e) => e.date).filter(Boolean).sort().pop();
    if (newest && newest !== f.seen) {
      f.seen = newest;
      changed = true;
    }
  }
  if (changed) await putFeeds(feeds);
  return { saved, errors: errors.slice(0, 10) };
}
