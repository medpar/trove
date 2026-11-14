// Telegram Bot API client and the pieces of the bot's UI (cards, pickers, parsing).
//   TELEGRAM_BOT_TOKEN        from @BotFather
//   TELEGRAM_WEBHOOK_SECRET   random string; Telegram echoes it in X-Telegram-Bot-Api-Secret-Token
//   TELEGRAM_ALLOWED_USERS    comma-separated Telegram user ids allowed to use the bot
import 'server-only';
import { createHash } from 'node:crypto';
import { env } from './env';
import type { Item } from './store';

export function telegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;
  return {
    token,
    secret: process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || '',
    allowed: new Set((process.env.TELEGRAM_ALLOWED_USERS || '').split(/[,\s]+/).filter(Boolean).map(Number)),
  };
}

export class TelegramError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Call a Bot API method. Retries once on flood control; "message is not modified" is not an error. */
export async function tg<T = any>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const cfg = telegramConfig();
  if (!cfg) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (data.ok) return data.result as T;
    const desc = String(data.description || res.statusText);
    if (data.error_code === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, Math.min(10, Number(data.parameters?.retry_after) || 2) * 1000));
      continue;
    }
    if (/message is not modified/i.test(desc)) return true as T;
    throw new TelegramError(data.error_code || res.status, desc);
  }
}

/** Download a file the user sent (the hosted Bot API serves files up to 20 MB). */
export async function downloadFile(fileId: string): Promise<{ bytes: Uint8Array; path: string }> {
  const cfg = telegramConfig()!;
  const f = await tg<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
  if (!f.file_path) throw new Error('Telegram did not return the file');
  const res = await fetch(`https://api.telegram.org/file/bot${cfg.token}/${f.file_path}`, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Could not download the file (${res.status})`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), path: f.file_path };
}

export const TG_FILE_MAX = 20 * 1024 * 1024;

// ---------- formatting ----------

export const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const short = (id: string) => id.replace(/-/g, '');
export const troveLink = (id: string, extra = '') => `${env().publicUrl}/?item=${id}${extra}`;
export const hash4 = (s: string) => createHash('sha1').update(s).digest('base64url').slice(0, 4);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Find the Trove item a bot message is about (its "Open in Trove" link carries the id). */
export function itemIdIn(msg: any): { id: string; ask?: string } | null {
  for (const e of [...(msg?.entities || []), ...(msg?.caption_entities || [])]) {
    if (e.type !== 'text_link' || !e.url) continue;
    try {
      const u = new URL(e.url);
      const id = u.searchParams.get('item');
      if (id && u.origin === new URL(env().publicUrl).origin) return { id, ask: u.searchParams.get('ask') || undefined };
    } catch { /* not ours */ }
  }
  return null;
}

export type CardState = 'saved' | 'exists' | 'updated' | 'deleted' | 'filing';

const length = (it: Item) => (it.duration ? `${Math.max(1, Math.round(it.duration / 60))} min` : it.readingTime ? `${it.readingTime} min read` : '');

export function cardText(it: Item, state: CardState, extra: { filed?: boolean; archived?: boolean; note?: string } = {}) {
  if (state === 'deleted') return `🗑 <s>${esc(clip(it.title || it.url, 120))}</s>\nMoved to the trash.`;
  const head = state === 'exists' ? '↺ <b>Already in Trove</b>' : state === 'updated' ? '✏️ <b>Updated</b>' : '✅ <b>Saved</b>';
  const meta = [it.type, it.platform && !['Web', 'Upload'].includes(it.platform) ? it.platform : '', length(it)].filter(Boolean).join(' · ');
  const title = it.url ? `<a href="${esc(it.url)}">${esc(clip(it.title || it.url, 160))}</a>` : esc(clip(it.title, 160));
  const where = `${it.collection ? `📁 ${esc(it.collection)}` : '📥 Unsorted'}${it.tags.length ? `   ${it.tags.map((t) => `#${esc(t.replace(/\s+/g, '_'))}`).join(' ')}` : ''}${it.favorite ? '   ⭐' : ''}`;
  const lines = [`${head}${meta ? ` · ${esc(meta)}` : ''}`, `<b>${title}</b>`, where];
  if (it.summary) lines.push(`<blockquote>${esc(clip(it.summary, 400))}</blockquote>`);
  else if (it.excerpt) lines.push(`<i>${esc(clip(it.excerpt.replace(/\s+/g, ' '), 220))}</i>`);
  if (it.note) lines.push(`📝 ${esc(clip(it.note, 300))}`);
  if (extra.note) lines.push(extra.note);
  const foot = [state === 'filing' ? '⏳ Filing and archiving…' : extra.filed ? '✨ Filed by AI' : '', extra.archived || it.snapshot || it.archive ? '🏛 Archived' : '', `<a href="${troveLink(it.id)}">Open in Trove</a>`].filter(Boolean);
  lines.push(foot.join(' · '));
  return lines.join('\n');
}

type Button = { text: string; callback_data?: string; url?: string; switch_inline_query_current_chat?: string };

export function cardKeyboard(it: Item, state: CardState): { inline_keyboard: Button[][] } {
  const id = short(it.id);
  if (state === 'deleted') return { inline_keyboard: [[{ text: '↩️ Undo', callback_data: `u:${id}` }]] };
  const open: Button = it.url ? { text: '↗ Open', url: it.url } : { text: '↗ Open', url: troveLink(it.id) };
  return {
    inline_keyboard: [
      [
        { text: '📁 Collection', callback_data: `m:${id}:0` },
        { text: '🏷 Tags', callback_data: `t:${id}:0` },
        { text: it.favorite ? '★ Favorite' : '☆ Favorite', callback_data: `f:${id}` },
      ],
      [{ text: it.read ? '✓ Read' : '○ Unread', callback_data: `r:${id}` }, { text: '🗑 Delete', callback_data: `d:${id}` }, open],
    ],
  };
}

export const PICK_PAGE = 10;

/** Collection picker: most used first, current one checked. */
export function collectionKeyboard(it: Item, names: string[], page: number) {
  const id = short(it.id);
  const pages = Math.max(1, Math.ceil(names.length / PICK_PAGE));
  page = Math.max(0, Math.min(page, pages - 1));
  const slice = names.slice(page * PICK_PAGE, (page + 1) * PICK_PAGE);
  const rows: Button[][] = [];
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(
      slice.slice(i, i + 2).map((name, j) => {
        const idx = page * PICK_PAGE + i + j;
        const label = clip(name.split('/').join(' › '), 30);
        return { text: `${it.collection === name ? '✓ ' : ''}${label}`, callback_data: `c:${id}:${idx}:${hash4(name)}` };
      }),
    );
  }
  rows.push([{ text: '➕ New collection', callback_data: `nc:${id}` }, { text: `${it.collection ? '' : '✓ '}📥 Unsorted`, callback_data: `c:${id}:-1:x` }]);
  const nav: Button[] = [];
  if (page > 0) nav.push({ text: '‹', callback_data: `m:${id}:${page - 1}` });
  nav.push({ text: '« Back', callback_data: `b:${id}` });
  if (page < pages - 1) nav.push({ text: '›', callback_data: `m:${id}:${page + 1}` });
  rows.push(nav);
  return { inline_keyboard: rows };
}

/** Tag picker: most used tags as toggles. */
export function tagKeyboard(it: Item, names: string[], page: number) {
  const id = short(it.id);
  const per = 12;
  // The item's own tags first, so they can be removed.
  const all = [...it.tags, ...names.filter((n) => !it.tags.includes(n))];
  const pages = Math.max(1, Math.ceil(all.length / per));
  page = Math.max(0, Math.min(page, pages - 1));
  const slice = all.slice(page * per, (page + 1) * per);
  const rows: Button[][] = [];
  for (let i = 0; i < slice.length; i += 3) {
    rows.push(
      slice.slice(i, i + 3).map((name) => {
        const idx = names.indexOf(name);
        return { text: `${it.tags.includes(name) ? '✓ ' : ''}${clip(name, 20)}`, callback_data: idx >= 0 ? `g:${id}:${idx}:${hash4(name)}` : `gx:${id}:${hash4(name)}` };
      }),
    );
  }
  rows.push([{ text: '➕ New tag', callback_data: `nt:${id}` }]);
  const nav: Button[] = [];
  if (page > 0) nav.push({ text: '‹', callback_data: `t:${id}:${page - 1}` });
  nav.push({ text: '« Done', callback_data: `b:${id}` });
  if (page < pages - 1) nav.push({ text: '›', callback_data: `t:${id}:${page + 1}` });
  rows.push(nav);
  return { inline_keyboard: rows };
}

/** A numbered list of items with buttons that open each one's card. */
export function listMessage(title: string, items: Item[], more?: { url: string; label: string }) {
  const lines = [`<b>${esc(title)}</b>`];
  items.forEach((it, i) => {
    const t = esc(clip(it.title || it.url, 90));
    const link = it.url ? `<a href="${esc(it.url)}">${t}</a>` : t;
    const where = [it.collection ? `📁 ${esc(it.collection)}` : '', it.tags.slice(0, 3).map((x) => `#${esc(x.replace(/\s+/g, '_'))}`).join(' ')].filter(Boolean).join(' ');
    lines.push(`${i + 1}. ${link}${where ? `\n    <i>${where}</i>` : ''}`);
  });
  const buttons: Button[] = items.map((it, i) => ({ text: String(i + 1), callback_data: `i:${short(it.id)}` }));
  const rows: Button[][] = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(buttons.slice(i, i + 5));
  if (more) rows.push([{ text: more.label, url: more.url }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// ---------- parsing what the user typed ----------

export { linksIn, parseDirectives, resolveCollection, resolveTag, type Directives } from './directives';
