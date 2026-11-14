// What people type when they save from Telegram, email subjects and the like: #tags, @Collection,
// !flags and links. Pure functions, no server-only imports, so the tests can load them.

export type Directives = { tags: string[]; collection?: string; favorite: boolean; read?: boolean; autofile?: boolean; rest: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/**
 * "#tag", "@Collection" or '@"Two words"', and flags: !fav (or ⭐), !read, !later, !raw (don't
 * let AI file it). Whatever is left is the note.
 */
export function parseDirectives(text: string): Directives {
  const out: Directives = { tags: [], favorite: false, rest: '' };
  let s = ` ${text.replace(URL_RE, ' ')} `;
  s = s.replace(/(^|\s)@(?:"([^"]+)"|“([^”]+)”|([\p{L}\p{N}_][\p{L}\p{N}_\-/.&+]*))/u, (_m, pre, a, b, c) => {
    out.collection = (a || b || c || '').trim().replace(/[.]+$/, '');
    return pre;
  });
  s = s.replace(/(^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_\-/.+]*)/gu, (_m, pre, tag) => {
    out.tags.push(tag.replace(/[.]+$/, '').replace(/_/g, ' '));
    return pre;
  });
  s = s.replace(/(^|\s)(!fav(?:orite)?|!star|⭐️?|🌟)(?=\s)/giu, (_m, pre) => ((out.favorite = true), pre));
  s = s.replace(/(^|\s)!read(?=\s)/gi, (_m, pre) => ((out.read = true), pre));
  s = s.replace(/(^|\s)!later(?=\s)/gi, (_m, pre) => ((out.read = false), pre));
  s = s.replace(/(^|\s)!(raw|nofile|noai)(?=\s)/gi, (_m, pre) => ((out.autofile = false), pre));
  out.tags = [...new Set(out.tags.filter(Boolean))];
  out.rest = s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return out;
}

/** Links in a message, including hidden ones behind text (text_link entities). */
export function linksIn(msg: any): string[] {
  const text: string = msg.text || msg.caption || '';
  const ents: any[] = msg.entities || msg.caption_entities || [];
  const urls: string[] = [];
  // Telegram offsets are in UTF-16 code units, which is what String.slice uses.
  for (const e of ents) {
    if (e.type === 'url') urls.push(text.slice(e.offset, e.offset + e.length));
    else if (e.type === 'text_link' && e.url) urls.push(e.url);
  }
  for (const m of text.match(URL_RE) || []) urls.push(m);
  return [...new Set(urls.map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`).replace(/[).,;:!?]+$/, '')))];
}

/** Match "@AI" to an existing "Dev/AI" (exact name first, then a unique last segment). */
export function resolveCollection(name: string, known: string[]): string {
  const n = name.trim().replace(/^\/+|\/+$/g, '');
  const lower = n.toLowerCase();
  const exact = known.find((k) => k.toLowerCase() === lower);
  if (exact) return exact;
  const leaf = known.filter((k) => k.split('/').pop()!.toLowerCase() === lower);
  if (leaf.length === 1) return leaf[0];
  const dashed = known.find((k) => k.toLowerCase().replace(/[\s_-]+/g, '') === lower.replace(/[\s_-]+/g, ''));
  return dashed || n;
}

export function resolveTag(name: string, known: string[]): string {
  const lower = name.toLowerCase();
  return known.find((k) => k.toLowerCase() === lower) || known.find((k) => k.toLowerCase().replace(/[\s_-]+/g, '') === lower.replace(/[\s_-]+/g, '')) || name;
}
