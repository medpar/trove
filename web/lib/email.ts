// Email to Trove: a Cloudflare Email Routing worker relays each message (raw MIME) here.
// Links in a short email are saved as links; a newsletter or long email is kept as an article;
// attachments become files. The subject can carry #tags, @Collection and !fav.
//   TROVE_EMAIL_SECRET   shared with the worker (header X-Trove-Email-Secret)
//   TROVE_EMAIL_FROM     comma-separated sender addresses allowed to save
import 'server-only';
import PostalMime from 'postal-mime';
import TurndownService from 'turndown';
import { afterSave } from './enrich';
import { saveFile } from './files';
import { invalidateStats, save, type SaveInput, type SaveResult } from './store';
import { cardText, cardKeyboard, parseDirectives, telegramConfig, tg } from './telegram';
import { findUrls } from './url';

export function emailConfig() {
  const secret = process.env.TROVE_EMAIL_SECRET?.trim();
  if (!secret) return null;
  return {
    secret,
    from: new Set((process.env.TROVE_EMAIL_FROM || '').split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)),
    address: process.env.TROVE_EMAIL_ADDRESS?.trim() || '',
  };
}

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
td.remove(['style', 'script', 'head', 'title']);

const NOISE = /(unsubscribe|manage (your )?preferences|view (this|it) in (your )?browser|list-manage\.com|mailchi\.mp|substack\.com\/(redirect|app-link)|click\.|\/track\/|utm_)/i;

function stripSubject(s: string) {
  return s.replace(/^\s*((re|fw|fwd|rv|enc|tr)\s*:\s*)+/i, '').trim();
}

/** Text the sender wrote above a forwarded message. */
function ownText(text: string) {
  const cut = text.search(/^(-{2,}\s*(forwarded message|mensaje reenviado|original message)|begin forwarded message:|on .+ wrote:|el .+ escribió:)/im);
  return (cut >= 0 ? text.slice(0, cut) : text).trim();
}

export type EmailResult = { saved: SaveResult[]; errors: string[]; kind: 'links' | 'article' | 'note' | 'files' | 'none'; base?: SaveInput };

export async function handleEmail(raw: ArrayBuffer | Uint8Array, envelopeFrom?: string): Promise<EmailResult> {
  const cfg = emailConfig()!;
  const mail = await PostalMime.parse(raw);
  const from = (envelopeFrom || mail.from?.address || '').toLowerCase();
  if (cfg.from.size && !cfg.from.has(from)) throw Object.assign(new Error(`Sender ${from || '(unknown)'} is not allowed`), { status: 403 });

  const subject = stripSubject(mail.subject || '');
  const d = parseDirectives(subject);
  const base: Partial<SaveInput> = { tags: d.tags.length ? d.tags : undefined, collection: d.collection, favorite: d.favorite || undefined, read: d.read, autofile: d.autofile, source: 'Email', via: 'Email' };
  const title = d.rest || subject;
  const text = (mail.text || '').replace(/\r/g, '');
  const mine = ownText(text);
  const html = mail.html || '';

  const out: EmailResult = { saved: [], errors: [], kind: 'none' };
  const run = async (fn: () => Promise<SaveResult>) => {
    try {
      out.saved.push(await fn());
    } catch (e: any) {
      out.errors.push(e?.message || String(e));
    }
  };

  // Attachments (inline images in newsletters are skipped).
  const files = (mail.attachments || []).filter((a) => a.disposition !== 'inline' && a.content && (a.content as ArrayBuffer).byteLength > 0);
  for (const a of files.slice(0, 10)) {
    const bytes = new Uint8Array(a.content as ArrayBuffer);
    await run(() => saveFile({ kind: 'bytes', bytes, filename: a.filename || undefined, contentType: a.mimeType }, { ...base, note: mine || undefined } as SaveInput));
  }

  const urlsInOwn = findUrls(mine).filter((u) => !NOISE.test(u));
  const ownRest = urlsInOwn.reduce((s, u) => s.replace(u, ''), mine).trim();
  const forwarded = mine.length < text.trim().length - 40 || /^(fw|fwd|rv|enc|tr)\s*:/i.test(mail.subject || '');

  if (urlsInOwn.length && ownRest.length < 600 && !forwarded) {
    out.kind = 'links';
    for (const url of urlsInOwn.slice(0, 10)) await run(() => save({ ...base, url, note: ownRest || undefined } as SaveInput));
  } else if (html.length > 1500 || text.length > 1200) {
    // A newsletter or a long email: keep the whole thing, readable, as an article.
    out.kind = 'article';
    const body = html ? td.turndown(html).replace(/\n{3,}/g, '\n\n') : text;
    const sender = mail.from?.name || mail.from?.address || '';
    const md = `${body.trim()}\n\n— ${forwarded ? 'Forwarded email' : 'Email'}${sender ? ` from ${sender}` : ''}${mail.date ? `, ${new Date(mail.date).toUTCString()}` : ''}`;
    await run(() => save({ ...base, text: md, title: title || 'Email', type: 'Article', note: forwarded && ownRest ? ownRest : undefined } as SaveInput));
  } else if (text.trim() || subject) {
    out.kind = files.length ? 'files' : 'note';
    if (text.trim() || !files.length) await run(() => save({ ...base, text: [title, text.trim()].filter(Boolean).join('\n\n'), title: title || undefined } as SaveInput));
  } else if (files.length) out.kind = 'files';

  invalidateStats();
  out.base = base as SaveInput;
  return out;
}

/** After the reply to the worker: file, summarize and archive, then tell you on Telegram. */
export async function finishEmail(out: EmailResult) {
  const base = out.base!;
  const tgCfg = telegramConfig();
  const owner = tgCfg ? [...tgCfg.allowed][0] : null;
  for (const r of out.saved) {
    const e = await afterSave(r, base as SaveInput).catch(() => null);
    const item = e?.item || r.item;
    if (owner) {
      await tg('sendMessage', {
        chat_id: owner,
        text: `📧 ${cardText(item, r.created ? 'saved' : 'exists', { filed: !!e?.filed?.collection })}`,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: cardKeyboard(item, 'saved'),
        disable_notification: true,
      }).catch(() => {});
    }
  }
}
