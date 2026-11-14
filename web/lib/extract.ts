// Turn a URL into rich, archivable content: metadata + a Markdown copy of the
// content itself (article text, post text, video description + transcript...).
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { domainOf, guessType, platformOf, tweetId, youtubeId, type ItemType, type Platform } from './url';

export type Media = { type: 'image' | 'video' | 'file'; url: string; alt?: string };

export type Extracted = {
  url: string;
  title: string;
  description: string;
  siteName: string;
  author: string;
  published: string | null;
  image: string | null;
  type: ItemType;
  platform: Platform;
  lang: string;
  markdown: string;
  text: string;
  words: number;
  duration: number | null;
  media: Media[];
  embed: string | null;
  extra: Record<string, unknown>;
  tweetId?: string;
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MAX_BYTES = 4_000_000;
const MAX_MD = 90_000;

async function get(url: string, { timeout = 9000, accept = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', headers = {} as Record<string, string> } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept, 'accept-language': 'en-US,en;q=0.9,es;q=0.8', ...headers }, redirect: 'follow', signal: ctrl.signal });
    const type = res.headers.get('content-type') || '';
    if (type.startsWith('text/') || type.includes('json') || type.includes('xml')) {
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        chunks.push(value);
        if (size > MAX_BYTES) {
          await reader.cancel();
          break;
        }
      }
      const buf = new Uint8Array(size);
      let off = 0;
      for (const c of chunks) {
        buf.set(c.subarray(0, Math.min(c.length, size - off)), off);
        off += c.length;
      }
      return { ok: res.ok, status: res.status, url: res.url || url, type, text: new TextDecoder().decode(buf) };
    }
    res.body?.cancel().catch(() => {});
    return { ok: res.ok, status: res.status, url: res.url || url, type, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T = any>(url: string, opts: Parameters<typeof get>[1] = {}): Promise<T | null> {
  try {
    const r = await get(url, { accept: 'application/json', ...opts });
    return r.ok ? (JSON.parse(r.text) as T) : null;
  } catch {
    return null;
  }
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
turndown.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button', 'svg', 'nav', 'footer'] as any);
turndown.addRule('lazyImages', {
  filter: 'img',
  replacement: (_c, node: any) => {
    const src = node.getAttribute('data-src') || node.getAttribute('src') || '';
    if (!/^https?:\/\//.test(src)) return '';
    const alt = (node.getAttribute('alt') || '').replace(/[[\]]/g, '');
    return `\n\n![${alt}](${src})\n\n`;
  },
});

export const htmlToMd = (html: string) => tidyMd(turndown.turndown(html || ''));

function tidyMd(md: string) {
  let out = md
    .replace(/\[\s*\]\([^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^#\s/gm, '## ')
    .trim();
  if (out.length > MAX_MD) out = out.slice(0, MAX_MD) + '\n\n*(Truncated: the full text was longer than Trove keeps.)*';
  return out;
}

const plain = (md: string) => md.replace(/!\[[^\]]*]\([^)]*\)/g, '').replace(/\[([^\]]*)]\([^)]*\)/g, '$1').replace(/[#>*_`~|-]+/g, ' ').replace(/\s+/g, ' ').trim();
const wordCount = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) || []).length;
const absolute = (u: string | null | undefined, base: string) => {
  if (!u) return null;
  try {
    return new URL(u, base).toString();
  } catch {
    return null;
  }
};
const iso = (s: unknown) => {
  if (!s) return null;
  const d = new Date(typeof s === 'number' && s < 1e12 ? s * 1000 : (s as string));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

function base(url: string, platform = platformOf(url)): Extracted {
  return {
    url,
    title: '',
    description: '',
    siteName: domainOf(url),
    author: '',
    published: null,
    image: null,
    type: guessType(url, platform),
    platform,
    lang: '',
    markdown: '',
    text: '',
    words: 0,
    duration: null,
    media: [],
    embed: null,
    extra: {},
  };
}

// ---------- generic HTML ----------

function jsonLd(document: any): any[] {
  const out: any[] = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const v = JSON.parse(s.textContent || 'null');
      const list = Array.isArray(v) ? v : v?.['@graph'] ? v['@graph'] : [v];
      out.push(...list.filter(Boolean));
    } catch { /* ignore broken JSON-LD */ }
  }
  return out;
}

export function parseHtmlPage(html: string, url: string, keepArticle = true): Extracted {
  const e = base(url);
  const { document } = parseHTML(html);
  const meta = (...names: string[]) => {
    for (const n of names) {
      const v = document.querySelector(`meta[property="${n}"]`)?.getAttribute('content') || document.querySelector(`meta[name="${n}"]`)?.getAttribute('content');
      if (v?.trim()) return v.trim();
    }
    return '';
  };
  const ld = jsonLd(document);
  const ldMain = ld.find((x) => /Article|BlogPosting|NewsArticle|VideoObject|Product|Recipe|WebPage/.test(String(x['@type']))) || {};
  const ldAuthor = Array.isArray(ldMain.author) ? ldMain.author[0] : ldMain.author;

  e.title = meta('og:title', 'twitter:title') || document.querySelector('title')?.textContent?.trim() || document.querySelector('h1')?.textContent?.trim() || '';
  e.description = meta('og:description', 'description', 'twitter:description');
  e.image = absolute(meta('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src') || document.querySelector('link[rel="image_src"]')?.getAttribute('href') || (ldMain.image?.url ?? (Array.isArray(ldMain.image) ? ldMain.image[0] : ldMain.image)), url);
  e.siteName = meta('og:site_name', 'application-name') || ldMain.publisher?.name || domainOf(url);
  e.author = meta('author', 'article:author', 'twitter:creator', 'parsely-author') || (typeof ldAuthor === 'string' ? ldAuthor : ldAuthor?.name) || '';
  e.published = iso(meta('article:published_time', 'og:published_time', 'date', 'pubdate', 'publish-date', 'datePublished') || ldMain.datePublished || document.querySelector('time[datetime]')?.getAttribute('datetime'));
  e.lang = (document.documentElement?.getAttribute('lang') || meta('og:locale') || '').slice(0, 2).toLowerCase();
  const ogType = meta('og:type');
  if (/video/.test(ogType) && e.type === 'Link') e.type = 'Video';
  if (/product/.test(ogType) && e.type === 'Link') e.type = 'Product';

  if (keepArticle) {
    try {
      const { document: doc2 } = parseHTML(html);
      const art = new Readability(doc2 as any, { charThreshold: 400 }).parse();
      if (art?.content && (art.textContent || '').trim().length > 400) {
        e.markdown = htmlToMd(art.content);
        e.text = (art.textContent || '').replace(/\s+/g, ' ').trim();
        e.words = wordCount(e.text);
        if (!e.author && art.byline) e.author = art.byline.trim();
        if (!e.description && art.excerpt) e.description = art.excerpt.trim();
        if (e.type === 'Link' && e.words > 250) e.type = 'Article';
      }
    } catch { /* Readability is best effort */ }
  }
  if (!e.text) e.text = [e.title, e.description].filter(Boolean).join(' — ');
  return e;
}

// ---------- platform extractors ----------

async function youtube(url: string): Promise<Extracted> {
  const id = youtubeId(url)!;
  const e = base(url, 'YouTube');
  e.type = 'Video';
  e.embed = `https://www.youtube.com/watch?v=${id}`;
  const oe = await getJson<any>(`https://www.youtube.com/oembed?url=${encodeURIComponent(e.embed)}&format=json`);
  e.title = oe?.title || '';
  e.author = oe?.author_name || '';
  e.image = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  e.siteName = 'YouTube';
  try {
    const page = await get(`${e.embed}&hl=en`, { headers: { cookie: 'CONSENT=YES+1; SOCS=CAI' } });
    const m = /ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:var|<\/script)/s.exec(page.text);
    let p: any = m ? JSON.parse(m[1]) : null;
    // Datacenter IPs often get a bot check instead of the page: ask the player API directly.
    if (!p?.videoDetails) p = await innertube(id);
    if (!p?.videoDetails) {
      // Still bot-checked: the watch-next endpoint keeps working and has the description.
      const n = await youtubeNext(id);
      if (n) {
        e.title ||= n.title;
        e.author ||= n.channel;
        e.description = n.description;
        e.published = n.published;
        e.extra = { views: n.views, likes: n.likes };
      }
    }
    if (p?.videoDetails) {
      const vd = p.videoDetails || {};
      const mf = p.microformat?.playerMicroformatRenderer || {};
      e.title ||= vd.title || '';
      e.author ||= vd.author || '';
      e.description = (vd.shortDescription || '').trim();
      e.duration = Number(vd.lengthSeconds) || null;
      e.published = iso(mf.publishDate || mf.uploadDate);
      e.extra = { channelId: vd.channelId, views: Number(vd.viewCount) || null, keywords: (vd.keywords || []).slice(0, 15) };
      const best = (vd.thumbnail?.thumbnails || []).sort((a: any, b: any) => (b.width || 0) - (a.width || 0))[0]?.url;
      if (best) e.image = best.split('?')[0];
      const tracks: any[] = p.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const track = tracks.find((t) => t.languageCode?.startsWith('en') && t.kind !== 'asr') || tracks.find((t) => t.kind !== 'asr') || tracks[0];
      if (track?.baseUrl) {
        const tr = await getJson<any>(`${track.baseUrl}&fmt=json3`);
        const lines: string[] = [];
        let bucket = '';
        let bucketStart = 0;
        for (const ev of tr?.events || []) {
          const txt = (ev.segs || []).map((s: any) => s.utf8).join('').replace(/\s+/g, ' ').trim();
          if (!txt) continue;
          const t = Math.floor((ev.tStartMs || 0) / 1000);
          if (!bucket) bucketStart = t;
          bucket += (bucket ? ' ' : '') + txt;
          if (t - bucketStart >= 60) {
            lines.push(`**${clock(bucketStart)}** ${bucket}`);
            bucket = '';
          }
        }
        if (bucket) lines.push(`**${clock(bucketStart)}** ${bucket}`);
        if (lines.length) e.extra.transcript = lines.join('\n\n');
      }
    }
  } catch { /* oEmbed data is enough */ }
  const parts = [`<video src="${e.embed}"></video>`];
  if (e.description) parts.push('## Description', linkifyMd(e.description));
  if (e.extra.transcript) parts.push('## Transcript', e.extra.transcript as string);
  e.markdown = tidyMd(parts.join('\n\n'));
  e.text = [e.title, e.description, e.extra.transcript].filter(Boolean).join(' ');
  e.words = wordCount(String(e.extra.transcript || e.description));
  return e;
}

const findKey2 = (o: any, key: string, depth = 0): any => {
  if (!o || typeof o !== 'object' || depth > 30) return undefined;
  if (key in o) return o[key];
  for (const v of Object.values(o)) {
    const f = findKey2(v, key, depth + 1);
    if (f !== undefined) return f;
  }
  return undefined;
};

async function youtubeNext(videoId: string) {
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20251020.01.00', hl: 'en' } }, videoId }),
      signal: AbortSignal.timeout(9000),
    });
    const n = await res.json();
    const primary = findKey2(n, 'videoPrimaryInfoRenderer');
    const secondary = findKey2(n, 'videoSecondaryInfoRenderer');
    const header = findKey2(n, 'videoDescriptionHeaderRenderer');
    const factoids: any[] = header?.factoid || [];
    const factoid = (label: RegExp) => factoids.map((f) => f.factoidRenderer).find((f) => label.test(f?.label?.simpleText || ''))?.value?.simpleText || null;
    const date = header?.publishDate?.simpleText || primary?.dateText?.simpleText;
    return {
      title: (primary?.title?.runs || []).map((r: any) => r.text).join(''),
      channel: secondary?.owner?.videoOwnerRenderer?.title?.runs?.[0]?.text || header?.channel?.simpleText || '',
      description: (secondary?.attributedDescription?.content || '').trim(),
      published: iso(date),
      views: (primary?.viewCount?.videoViewCountRenderer?.viewCount?.simpleText || '').replace(/[^\d]/g, '') || null,
      likes: factoid(/likes/i),
    };
  } catch {
    return null;
  }
}

async function innertube(videoId: string): Promise<any | null> {
  const clients = [
    { clientName: 'ANDROID', clientVersion: '19.44.38', androidSdkVersion: 34, hl: 'en' },
    { clientName: 'WEB', clientVersion: '2.20251020.01.00', hl: 'en' },
  ];
  for (const client of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': client.clientName === 'ANDROID' ? 'com.google.android.youtube/19.44.38 (Linux; U; Android 14) gzip' : UA },
        body: JSON.stringify({ context: { client }, videoId }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await res.json();
      if (j?.videoDetails) return j;
    } catch { /* try the next client */ }
  }
  return null;
}

/** Parse YouTube's player response captured by the browser extension (same shape as the page's). */
export function playerFromPageScripts(scripts: string): any | null {
  const m = /ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:var|$)/s.exec(scripts);
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
}

export type YouTubeData = { title?: string; author?: string; description?: string; duration?: number | null; published?: string | null; transcript?: string; views?: number | null };

/** Markdown sections for YouTube data (used at save time and when the extension enriches later). */
export function youtubeSections(d: YouTubeData) {
  const parts: string[] = [];
  if (d.description) parts.push('## Description', linkifyMd(d.description));
  if (d.transcript) parts.push('## Transcript', d.transcript);
  return tidyMd(parts.join('\n\n'));
}

function applyYouTube(e: Extracted, d: YouTubeData): Extracted {
  const out = { ...e, type: 'Video' as const, platform: 'YouTube' as const };
  out.title = d.title || out.title;
  out.author = d.author || out.author;
  out.description = d.description || out.description;
  out.duration = d.duration || out.duration;
  out.published = d.published || out.published;
  const embed = out.embed || out.url;
  out.markdown = tidyMd([`<video src="${embed}"></video>`, youtubeSections(d)].filter(Boolean).join('\n\n'));
  out.text = [out.title, d.description, d.transcript].filter(Boolean).join(' ');
  out.words = wordCount(String(d.transcript || d.description || ''));
  return out;
}

const clock = (s: number) => `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ':' : ''}${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const linkifyMd = (s: string) => s.replace(/(https?:\/\/[^\s)]+)/g, '[$1]($1)').replace(/\n/g, '  \n');

/** X posts via the public FxTwitter API (no login needed). Returns the raw FxTwitter tweet. */
export async function fxTweet(id: string): Promise<any | null> {
  const j = await getJson<any>(`https://api.fxtwitter.com/status/${id}`, { timeout: 10000 });
  return j?.tweet || null;
}

async function reddit(url: string): Promise<Extracted> {
  const e = base(url, 'Reddit');
  const u = new URL(url);
  const path = u.pathname.replace(/\/$/, '');
  const j = (await getJson<any>(`https://www.reddit.com${path}.json?raw_json=1&limit=1`)) || (await getJson<any>(`https://old.reddit.com${path}.json?raw_json=1&limit=1`));
  const post = j?.[0]?.data?.children?.[0]?.data;
  if (!post) {
    // Reddit often blocks JSON for server IPs; its oEmbed endpoint still answers.
    const oe = await getJson<any>(`https://www.reddit.com/oembed?url=${encodeURIComponent(url)}`);
    if (!oe?.title) return fallbackHtml(url, e);
    e.type = 'Post';
    e.title = oe.title;
    e.author = oe.author_name ? `u/${oe.author_name}` : '';
    e.siteName = /\/r\/([^/]+)/.exec(url)?.[1] ? `r/${/\/r\/([^/]+)/.exec(url)![1]}` : 'Reddit';
    e.embed = url;
    e.markdown = `<embed src="${url}"></embed>`;
    e.text = e.title;
    return e;
  }
  e.type = 'Post';
  e.title = post.title || '';
  e.author = post.author ? `u/${post.author}` : '';
  e.siteName = `r/${post.subreddit}`;
  e.published = iso(post.created_utc);
  e.description = (post.selftext || '').slice(0, 300);
  const imgs: string[] = [];
  if (post.is_gallery && post.media_metadata) {
    for (const v of Object.values<any>(post.media_metadata)) if (v?.s?.u) imgs.push(v.s.u);
  } else if (post.preview?.images?.[0]?.source?.url) imgs.push(post.preview.images[0].source.url);
  e.image = imgs[0] || null;
  e.media = imgs.slice(0, 6).map((u) => ({ type: 'image' as const, url: u }));
  const video = post.secure_media?.reddit_video?.fallback_url;
  if (video) e.media.push({ type: 'video', url: video });
  const link = post.is_self ? '' : post.url_overridden_by_dest || '';
  e.extra = { score: post.score, comments: post.num_comments, subreddit: post.subreddit, link };
  const parts = [`**${e.siteName}** · ${e.author} · ▲ ${post.score} · ${post.num_comments} comments`];
  if (link && !/redd\.it|reddit\.com/.test(link)) parts.push(`<bookmark url="${link}"></bookmark>`);
  if (post.selftext) parts.push(post.selftext);
  for (const m of e.media) if (m.type === 'image') parts.push(`![](${m.url})`);
  e.markdown = tidyMd(parts.join('\n\n'));
  e.text = [e.title, post.selftext].filter(Boolean).join(' ');
  e.words = wordCount(post.selftext || '');
  return e;
}

async function bluesky(url: string): Promise<Extracted> {
  const e = base(url, 'Bluesky');
  const m = /bsky\.app\/profile\/([^/]+)\/post\/([\w]+)/.exec(url);
  if (!m) return fallbackHtml(url, e);
  let did = m[1];
  if (!did.startsWith('did:')) did = (await getJson<any>(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${m[1]}`))?.did || '';
  const t = did && (await getJson<any>(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(`at://${did}/app.bsky.feed.post/${m[2]}`)}&depth=0&parentHeight=0`));
  const post = t?.thread?.post;
  if (!post) return fallbackHtml(url, e);
  e.type = 'Post';
  const text: string = post.record?.text || '';
  e.title = text.split('\n')[0].slice(0, 140) || `Post by @${post.author?.handle}`;
  e.author = `${post.author?.displayName || ''} @${post.author?.handle}`.trim();
  e.published = iso(post.record?.createdAt);
  e.description = text.slice(0, 300);
  const imgs = post.embed?.images || post.embed?.media?.images || [];
  e.media = imgs.map((i: any) => ({ type: 'image' as const, url: i.fullsize, alt: i.alt }));
  e.image = e.media[0]?.url || post.embed?.external?.thumb || null;
  e.extra = { likes: post.likeCount, reposts: post.repostCount, replies: post.replyCount };
  const parts = [linkifyMd(text)];
  if (post.embed?.external?.uri) parts.push(`<bookmark url="${post.embed.external.uri}"></bookmark>`);
  for (const i of e.media) parts.push(`![${(i.alt || '').replace(/[[\]]/g, '')}](${i.url})`);
  parts.push(`*♥ ${post.likeCount ?? 0} · ↻ ${post.repostCount ?? 0} · 💬 ${post.replyCount ?? 0}*`);
  e.markdown = tidyMd(parts.join('\n\n'));
  e.text = text;
  e.words = wordCount(text);
  return e;
}

async function mastodon(url: string): Promise<Extracted> {
  const e = base(url, 'Mastodon');
  const u = new URL(url);
  const id = u.pathname.split('/').pop();
  const s = await getJson<any>(`${u.origin}/api/v1/statuses/${id}`);
  if (!s) return fallbackHtml(url, e);
  e.type = 'Post';
  const md = htmlToMd(s.content || '');
  e.title = plain(md).slice(0, 140) || `Post by @${s.account?.acct}`;
  e.author = `${s.account?.display_name || ''} @${s.account?.acct}@${u.hostname}`.trim();
  e.published = iso(s.created_at);
  e.description = plain(md).slice(0, 300);
  e.media = (s.media_attachments || []).map((m: any) => ({ type: m.type === 'image' ? ('image' as const) : ('video' as const), url: m.url, alt: m.description || '' }));
  e.image = (s.media_attachments || [])[0]?.preview_url || s.card?.image || null;
  const parts = [md];
  if (s.card?.url) parts.push(`<bookmark url="${s.card.url}"></bookmark>`);
  for (const m of e.media) parts.push(m.type === 'image' ? `![${(m.alt || '').replace(/[[\]]/g, '')}](${m.url})` : `<video src="${m.url}"></video>`);
  parts.push(`*★ ${s.favourites_count} · ↻ ${s.reblogs_count} · 💬 ${s.replies_count}*`);
  e.markdown = tidyMd(parts.join('\n\n'));
  e.text = plain(md);
  e.words = wordCount(e.text);
  return e;
}

async function hackerNews(url: string): Promise<Extracted> {
  const e = base(url, 'Hacker News');
  const id = new URL(url).searchParams.get('id');
  const it = id && (await getJson<any>(`https://hn.algolia.com/api/v1/items/${id}`));
  if (!it) return fallbackHtml(url, e);
  e.type = 'Post';
  e.title = it.title || plain(htmlToMd(it.text || '')).slice(0, 120);
  e.author = it.author || '';
  e.published = iso(it.created_at);
  e.siteName = 'Hacker News';
  const comments = (it.children || []).length;
  e.extra = { points: it.points, comments, link: it.url };
  const parts = [`▲ ${it.points ?? 0} points · ${comments} comments · by ${it.author}`];
  if (it.url) parts.push(`<bookmark url="${it.url}"></bookmark>`);
  if (it.text) parts.push(htmlToMd(it.text));
  e.markdown = tidyMd(parts.join('\n\n'));
  e.description = it.url ? `Discussion of ${domainOf(it.url)}` : plain(htmlToMd(it.text || '')).slice(0, 300);
  e.text = [e.title, plain(htmlToMd(it.text || ''))].join(' ');
  return e;
}

/** GitHub API headers; GITHUB_TOKEN (optional, no scopes needed) lifts the 60 requests/hour limit. */
export const githubHeaders = (accept = 'application/vnd.github+json'): Record<string, string> => ({
  accept,
  'x-github-api-version': '2022-11-28',
  ...(process.env.GITHUB_TOKEN?.trim() ? { authorization: `Bearer ${process.env.GITHUB_TOKEN.trim()}` } : {}),
});

async function github(url: string): Promise<Extracted> {
  const m = /github\.com\/([^/]+)\/([^/#?]+)\/?$/.exec(url);
  if (!m) return fallbackHtml(url, base(url, 'GitHub'));
  const repo = await getJson<any>(`https://api.github.com/repos/${m[1]}/${m[2]}`, { headers: githubHeaders() });
  if (!repo) return fallbackHtml(url, base(url, 'GitHub'));
  return githubRepo(repo, url);
}

/** A repo as Trove stores it, from a GitHub API repo object (README read from raw.githubusercontent.com, which costs no API quota). */
export async function githubRepo(repo: any, url = repo.html_url): Promise<Extracted> {
  const e = base(url, 'GitHub');
  e.type = 'Repo';
  e.title = repo.full_name;
  e.description = repo.description || '';
  e.author = repo.owner?.login || '';
  e.published = iso(repo.created_at);
  e.image = `https://opengraph.githubassets.com/1/${repo.full_name}`;
  e.extra = { stars: repo.stargazers_count, forks: repo.forks_count, language: repo.language, topics: repo.topics, license: repo.license?.spdx_id };
  let readme = '';
  for (const name of ['README.md', 'readme.md', 'README.rst', 'README']) {
    try {
      const r = await get(`https://raw.githubusercontent.com/${repo.full_name}/HEAD/${name}`, { accept: 'text/plain' });
      if (r.ok && r.text.trim()) {
        readme = r.text;
        break;
      }
    } catch { /* try the next name */ }
  }
  const facts = [`★ ${repo.stargazers_count}`, `⑂ ${repo.forks_count}`, repo.language, repo.license?.spdx_id].filter(Boolean).join(' · ');
  const parts = [facts];
  if (repo.homepage) parts.push(`Homepage: [${repo.homepage}](${repo.homepage})`);
  if (repo.topics?.length) parts.push(repo.topics.map((t: string) => `\`${t}\``).join(' '));
  if (readme) parts.push('## README', readme.replace(/^#\s/gm, '### ').replace(/<[^>]+>/g, ''));
  e.markdown = tidyMd(parts.join('\n\n'));
  e.text = [e.title, e.description, plain(readme).slice(0, 6000)].join(' ');
  e.words = wordCount(readme);
  return e;
}

async function arxiv(url: string): Promise<Extracted> {
  const e = base(url, 'arXiv');
  const id = /arxiv\.org\/(?:abs|pdf|html)\/([\w.\/-]+?)(?:v\d+)?(?:\.pdf)?$/.exec(url)?.[1];
  if (!id) return fallbackHtml(url, e);
  const r = await get(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, { accept: 'application/atom+xml' }).catch(() => null);
  const entry = r?.text.split('<entry>')[1] || '';
  const tag = (t: string) => (new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(entry)?.[1] || '').replace(/\s+/g, ' ').trim();
  e.type = 'Paper';
  e.title = tag('title') || id;
  e.author = [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]).slice(0, 6).join(', ');
  e.published = iso(tag('published'));
  e.description = tag('summary').slice(0, 600);
  e.siteName = 'arXiv';
  e.media = [{ type: 'file', url: `https://arxiv.org/pdf/${id}` }];
  e.markdown = tidyMd([`**${e.author}**`, '## Abstract', tag('summary'), `[PDF](https://arxiv.org/pdf/${id}) · [Abstract page](https://arxiv.org/abs/${id})`].join('\n\n'));
  e.text = [e.title, tag('summary')].join(' ');
  e.words = wordCount(tag('summary'));
  return e;
}

const OEMBED: [RegExp, string][] = [
  [/tiktok\.com/, 'https://www.tiktok.com/oembed?url='],
  [/vimeo\.com/, 'https://vimeo.com/api/oembed.json?url='],
  [/open\.spotify\.com/, 'https://open.spotify.com/oembed?url='],
  [/soundcloud\.com/, 'https://soundcloud.com/oembed?format=json&url='],
];

async function oembed(url: string, e: Extracted): Promise<Extracted> {
  const ep = OEMBED.find(([re]) => re.test(url))?.[1];
  const oe = ep ? await getJson<any>(ep + encodeURIComponent(url)) : null;
  const page = await fallbackHtml(url, e, false);
  if (oe) {
    page.title = oe.title || page.title;
    page.author = oe.author_name || page.author;
    page.image = oe.thumbnail_url || page.image;
  }
  page.embed = url;
  page.markdown = tidyMd([`<embed src="${url}"></embed>`, page.description ? linkifyMd(page.description) : ''].filter(Boolean).join('\n\n'));
  return page;
}

async function fallbackHtml(url: string, e: Extracted, keepArticle = true): Promise<Extracted> {
  try {
    const r = await get(url);
    if (!r.ok && !r.text) return { ...e, title: e.title || domainOf(url) };
    if (!r.type.includes('html') && !r.text.startsWith('<')) {
      const type = guessType(url, e.platform, r.type);
      const name = decodeURIComponent(new URL(r.url).pathname.split('/').pop() || domainOf(url));
      const media: Media[] = type === 'Document' || type === 'Paper' || type === 'Audio' ? [{ type: 'file', url: r.url }] : type === 'Video' ? [{ type: 'video', url: r.url }] : [];
      return { ...e, type, media, title: e.title || name.replace(/\.\w{2,4}$/, '').replace(/[-_]+/g, ' '), image: type === 'Image' ? url : e.image };
    }
    const page = parseHtmlPage(r.text, r.url, keepArticle);
    return { ...page, platform: e.platform, type: e.type !== 'Link' && page.type !== 'Article' ? e.type : page.type, extra: { ...page.extra, httpStatus: r.status } };
  } catch {
    return { ...e, title: e.title || domainOf(url) };
  }
}

/** Main entry: extract everything we can about a URL. Never throws. */
export async function extract(url: string): Promise<Extracted> {
  const platform = platformOf(url);
  try {
    if (platform === 'YouTube' && youtubeId(url)) return await youtube(url);
    if (platform === 'X' && tweetId(url)) return { ...base(url, 'X'), type: 'Post', tweetId: tweetId(url)! };
    if (platform === 'Reddit' && /\/comments\//.test(url)) return await reddit(url);
    if (platform === 'Bluesky') return await bluesky(url);
    if (platform === 'Mastodon') return await mastodon(url);
    if (platform === 'Hacker News' && /item\?id=/.test(url)) return await hackerNews(url);
    if (platform === 'GitHub') return await github(url);
    if (platform === 'arXiv') return await arxiv(url);
    if (OEMBED.some(([re]) => re.test(url))) return await oembed(url, base(url, platform));
    return await fallbackHtml(url, base(url, platform));
  } catch {
    return { ...base(url, platform), title: domainOf(url) };
  }
}

/** Merge metadata captured in the browser (extension / bookmarklet) over server-side extraction. */
export function mergeClientMeta(e: Extracted, m: Partial<{ title: string; description: string; image: string; author: string; published: string; siteName: string; html: string; text: string; lang: string; youtube: YouTubeData }>): Extracted {
  let out = { ...e };
  // YouTube data read by the browser extension (servers often get bot-checked by YouTube).
  if (m.youtube && e.platform === 'YouTube' && (!e.duration || !e.markdown.includes('## Transcript'))) out = applyYouTube(out, m.youtube);
  if (m.html && !out.markdown) {
    const page = parseHtmlPage(m.html, e.url, true);
    if (page.markdown) {
      out.markdown = page.markdown;
      out.text = page.text;
      out.words = page.words;
      if (out.type === 'Link') out.type = page.type;
    }
  }
  if (m.title && (!out.title || out.title === domainOf(e.url))) out.title = m.title;
  if (m.description && !out.description) out.description = m.description;
  if (m.image && !out.image) out.image = m.image;
  if (m.author && !out.author) out.author = m.author;
  if (m.published && !out.published) out.published = iso(m.published);
  if (m.siteName && (!out.siteName || out.siteName === domainOf(e.url))) out.siteName = m.siteName;
  if (m.lang && !out.lang) out.lang = m.lang.slice(0, 2);
  if (m.text && !out.text) {
    out.text = m.text;
    out.words = wordCount(m.text);
  }
  return out;
}

export { plain, wordCount };
