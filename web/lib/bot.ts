// The Trove Telegram bot: send or forward anything to save it, then file it with buttons.
import 'server-only';
import { afterSave } from './enrich';
import { saveFile } from './files';
import { ask, forget, hybridSearch } from './semantic';
import { env } from './env';
import { getItem, invalidateStats, list, remove, restore, save, stats, update, type Item, type SaveInput, type SaveResult } from './store';
import {
  TG_FILE_MAX, cardKeyboard, cardText, collectionKeyboard, downloadFile, esc, hash4, itemIdIn, linksIn, listMessage, parseDirectives, resolveCollection, resolveTag, short, tagKeyboard,
  telegramConfig, tg, troveLink, type CardState, type Directives,
} from './telegram';
import { BROWSER_COLLECTION, GITHUB_COLLECTION, PINTEREST_COLLECTION, X_COLLECTION } from './library-schema.js';

const VIA = 'Telegram';
const SYSTEM = [X_COLLECTION, BROWSER_COLLECTION, PINTEREST_COLLECTION, GITHUB_COLLECTION];

// Telegram may deliver an update twice if a response is slow; remember recent ones per instance.
const seen = new Set<number>();
function firstTime(updateId: number) {
  if (seen.has(updateId)) return false;
  seen.add(updateId);
  if (seen.size > 500) seen.delete(seen.values().next().value!);
  return true;
}

const allowed = (userId?: number) => {
  const cfg = telegramConfig();
  return !!userId && !!cfg && cfg.allowed.has(userId);
};

const fullId = (s: string) => (s.length === 32 ? `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}` : s);

async function collectionNames() {
  const s = await stats();
  return [...s.collections].filter((c) => !SYSTEM.some((x) => c.name === x || c.name.startsWith(`${x}/`))).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).map((c) => c.name);
}
async function tagNames() {
  return (await stats()).tags.map((t) => t.name);
}

const react = (chat_id: number, message_id: number, emoji: string | null) =>
  tg('setMessageReaction', { chat_id, message_id, reaction: emoji ? [{ type: 'emoji', emoji }] : [] }).catch(() => {});

async function sendCard(chatId: number, it: Item, state: CardState, opts: { replyTo?: number; filed?: boolean; archived?: boolean; note?: string } = {}) {
  return tg<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: cardText(it, state, opts),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: cardKeyboard(it, state),
    ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
  });
}

async function editCard(chatId: number, messageId: number, it: Item, state: CardState, opts: { filed?: boolean; archived?: boolean; note?: string } = {}) {
  return tg('editMessageText', { chat_id: chatId, message_id: messageId, text: cardText(it, state, opts), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: cardKeyboard(it, state) });
}

const say = (chatId: number, text: string, extra: Record<string, unknown> = {}) =>
  tg<{ message_id: number }>('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });

// ---------- entry point ----------

export async function handleUpdate(u: any) {
  if (typeof u.update_id === 'number' && !firstTime(u.update_id)) return;
  if (u.callback_query) return onCallback(u.callback_query);
  if (u.inline_query) return onInline(u.inline_query);
  if (u.guest_message) return onGuest(u.guest_message);
  const msg = u.message;
  if (!msg) return;
  if (!allowed(msg.from?.id)) {
    if (msg.chat?.type === 'private') await say(msg.chat.id, 'This is a private Trove bot. Run your own: https://github.com/medpar/trove').catch(() => {});
    return;
  }
  try {
    await onMessage(msg);
  } catch (e: any) {
    await say(msg.chat.id, `⚠️ ${esc(e?.message || String(e))}`, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }).catch(() => {});
    await react(msg.chat.id, msg.message_id, '😢');
  }
}

// ---------- messages ----------

const COMMANDS: Record<string, (chatId: number, arg: string, msg: any) => Promise<unknown>> = {
  start: (c) => help(c, true),
  help: (c) => help(c),
  search: (c, a) => (a ? search(c, a) : say(c, 'Send <code>/search what you remember</code>, or start a message with <code>?</code>.')),
  s: (c, a) => search(c, a),
  ask: (c, a) => (a ? answer(c, a) : say(c, 'Ask anything about what you saved: <code>/ask what did I save about pricing?</code>')),
  recent: (c) => recent(c),
  later: (c) => later(c),
  random: (c) => random(c),
  collections: (c) => collectionsList(c),
  tags: (c) => tagsList(c),
  stats: (c) => statsMessage(c),
};

async function onMessage(msg: any) {
  const chatId: number = msg.chat.id;
  const text: string = msg.text || msg.caption || '';

  const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (cmd && msg.text) {
    const fn = COMMANDS[cmd[1].toLowerCase()];
    if (fn) return fn(chatId, (cmd[2] || '').trim(), msg);
    return say(chatId, 'Unknown command. Send /help for what I can do.');
  }
  if (msg.text && /^\?\?\s*\S/.test(text)) return answer(chatId, text.replace(/^\?\?\s*/, ''));
  if (msg.text && /^\?\s*\S/.test(text)) return search(chatId, text.replace(/^\?\s*/, ''));

  // A reply to one of our cards or prompts edits that item.
  const ref = msg.reply_to_message?.from?.is_bot ? itemIdIn(msg.reply_to_message) : null;
  if (ref && msg.text && !linksIn(msg).length) return editFromReply(msg, ref.id, ref.ask, msg.reply_to_message);

  await react(chatId, msg.message_id, '👀');
  tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  const forwarded = msg.forward_origin ? origin(msg.forward_origin) : null;
  const d: Directives = forwarded ? { tags: [], favorite: false, rest: text.replace(/\bhttps?:\/\/\S+/g, '').trim() } : parseDirectives(text);
  const known = await collectionNames();
  const base: Partial<SaveInput> = {
    tags: d.tags.length ? d.tags : undefined,
    collection: d.collection ? resolveCollection(d.collection, known) : undefined,
    favorite: d.favorite || undefined,
    read: d.read,
    autofile: d.autofile,
    source: VIA,
    via: VIA,
  };
  if (base.tags) {
    const tags = await tagNames();
    base.tags = d.tags.map((t) => resolveTag(t, tags));
  }

  const file = fileOf(msg);
  const urls = linksIn(msg);
  const jobs: (() => Promise<SaveResult>)[] = [];

  if (file) {
    if ((file.size || 0) > TG_FILE_MAX) throw new Error('Telegram only lets bots download files up to 20 MB. For bigger files use the Share sheet → Save to Trove, or send a link.');
    const caption = d.rest;
    const titleLike = caption && caption.length <= 120 && !caption.includes('\n');
    jobs.push(async () => {
      const { bytes, path } = await downloadFile(file.id);
      const filename = file.name || `${file.kind}-${new Date().toISOString().slice(0, 10)}${/\.\w+$/.exec(path)?.[0] || ''}`;
      const input: SaveInput = {
        ...base,
        title: titleLike && !forwarded ? caption : undefined,
        note: [forwarded ? `Forwarded from ${forwarded.label}${forwarded.link ? ` (${forwarded.link})` : ''}` : '', !titleLike || forwarded ? caption : ''].filter(Boolean).join('\n\n') || undefined,
        url: urls[0],
      } as SaveInput;
      return saveFile({ kind: 'bytes', bytes, filename, contentType: file.mime }, input, { description: forwarded ? caption : undefined, duration: file.duration || null });
    });
  } else if (urls.length) {
    const note = forwarded
      ? [`Forwarded from ${forwarded.label}${forwarded.link ? ` (${forwarded.link})` : ''}`, d.rest.slice(0, 1500)].filter(Boolean).join('\n\n')
      : d.rest || undefined;
    for (const url of urls.slice(0, 10)) jobs.push(() => save({ ...base, url, note } as SaveInput));
  } else if (text.trim()) {
    const body = forwarded ? `${text.trim()}\n\n— ${forwarded.label}${forwarded.link ? ` · ${forwarded.link}` : ''}` : d.rest || text.trim();
    jobs.push(() => save({ ...base, text: body } as SaveInput));
  } else {
    await react(chatId, msg.message_id, null);
    return say(chatId, 'Send me a link, text, photo, video, audio or a file and I’ll save it. /help');
  }

  for (const job of jobs) {
    const r = await job();
    invalidateStats();
    const input = { ...base } as SaveInput;
    const fresh = r.created;
    const sent = await sendCard(chatId, r.item, fresh ? 'filing' : 'exists', { replyTo: msg.message_id });
    if (!fresh) continue;
    try {
      const e = await afterSave(r, input);
      if (e) await editCard(chatId, sent.message_id, e.item, 'saved', { filed: !!e.filed?.collection || !!e.filed?.tags.length, archived: !!(e.snapshot || e.archive || e.item.snapshot || e.item.archive) });
      else await editCard(chatId, sent.message_id, r.item, 'saved');
    } catch {
      await editCard(chatId, sent.message_id, r.item, 'saved').catch(() => {});
    }
  }
  await react(chatId, msg.message_id, '👍');
}

type FileRef = { id: string; size?: number; name?: string; mime?: string; kind: string; duration?: number };

function fileOf(msg: any): FileRef | null {
  if (msg.photo?.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { id: p.file_id, size: p.file_size, kind: 'photo', mime: 'image/jpeg' };
  }
  const pick = (o: any, kind: string, mime?: string): FileRef | null =>
    o ? { id: o.file_id, size: o.file_size, name: o.file_name, mime: o.mime_type || mime, kind, duration: o.duration } : null;
  return (
    pick(msg.document, 'document') ||
    pick(msg.video, 'video', 'video/mp4') ||
    pick(msg.animation, 'animation', 'video/mp4') ||
    pick(msg.audio, 'audio', 'audio/mpeg') ||
    pick(msg.voice, 'voice', 'audio/ogg') ||
    pick(msg.video_note, 'video-note', 'video/mp4')
  );
}

function origin(o: any): { label: string; link?: string } {
  if (o.type === 'channel' || o.type === 'chat') {
    const chat = o.chat || o.sender_chat || {};
    const label = chat.title || chat.username || 'a channel';
    return { label, link: chat.username && o.message_id ? `https://t.me/${chat.username}/${o.message_id}` : undefined };
  }
  if (o.type === 'user') return { label: [o.sender_user?.first_name, o.sender_user?.last_name].filter(Boolean).join(' ') || o.sender_user?.username || 'someone' };
  return { label: o.sender_user_name || 'someone' };
}

/** Reply to a card: "#tag @Collection !fav", or plain text that is added to the note. */
async function editFromReply(msg: any, idRaw: string, askKind: string | undefined, card: any) {
  const id = fullId(idRaw);
  const chatId = msg.chat.id;
  const text: string = msg.text.trim();
  const { item } = await getItem(id);
  let patch: Parameters<typeof update>[1] = {};
  if (askKind === 'collection') {
    patch.collection = text.replace(/^@/, '').replace(/^"|"$/g, '').trim() || null;
  } else if (askKind === 'tags') {
    const tags = await tagNames();
    patch.tags = [...item.tags, ...text.split(/[,\n]+|\s+(?=#)/).map((t) => t.trim().replace(/^#/, '')).filter(Boolean).map((t) => resolveTag(t, tags))];
  } else if (/^\/(del|delete)$/i.test(text)) {
    await remove(id);
    invalidateStats();
    await react(chatId, msg.message_id, '👌');
    return editCard(chatId, card.message_id, item, 'deleted').catch(() => sendCard(chatId, item, 'deleted'));
  } else {
    const d = parseDirectives(text);
    if (d.tags.length) {
      const tags = await tagNames();
      patch.tags = [...item.tags, ...d.tags.map((t) => resolveTag(t, tags))];
    }
    if (d.collection) patch.collection = resolveCollection(d.collection, await collectionNames());
    if (d.favorite) patch.favorite = true;
    if (d.read !== undefined) patch.read = d.read;
    if (d.rest) patch.note = [item.note, d.rest].filter(Boolean).join('\n\n');
  }
  patch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (!Object.keys(patch).length) return say(chatId, 'Nothing to change. Reply with <code>#tags</code>, <code>@Collection</code>, <code>!fav</code> or a note.');
  const updated = await update(id, patch);
  invalidateStats();
  await react(chatId, msg.message_id, '👌');
  // A prompt ("New collection for…") gets a fresh card; a card is edited in place.
  if (askKind) return sendCard(chatId, updated, 'updated');
  return editCard(chatId, card.message_id, updated, 'updated').catch(() => sendCard(chatId, updated, 'updated'));
}

// ---------- buttons ----------

async function onCallback(q: any) {
  const answer = (text?: string, alert = false) => tg('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
  if (!allowed(q.from?.id)) return answer('This is a private bot.', true);
  const chatId: number = q.message?.chat?.id;
  const messageId: number = q.message?.message_id;
  const [op, rawId, a, b] = String(q.data || '').split(':');
  const id = fullId(rawId || '');
  try {
    const current = async () => (await getItem(id)).item;
    const setKeyboard = (reply_markup: unknown) => tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup });
    switch (op) {
      case 'm': {
        const [it, names] = await Promise.all([current(), collectionNames()]);
        await setKeyboard(collectionKeyboard(it, names, Number(a) || 0));
        return answer();
      }
      case 'c': {
        let name: string | null = null;
        if (a !== '-1') {
          const names = await collectionNames();
          name = names[Number(a)];
          if (!name || hash4(name) !== b) {
            const it = await current();
            await setKeyboard(collectionKeyboard(it, names, 0));
            return answer('Your collections changed, pick again.');
          }
        }
        const it = await update(id, { collection: name });
        invalidateStats();
        await editCard(chatId, messageId, it, 'updated');
        return answer(name ? `Moved to ${name}` : 'Moved to Unsorted');
      }
      case 't': {
        const [it, names] = await Promise.all([current(), tagNames()]);
        await setKeyboard(tagKeyboard(it, names, Number(a) || 0));
        return answer();
      }
      case 'g':
      case 'gx': {
        const [it, names] = await Promise.all([current(), tagNames()]);
        const name = op === 'g' ? names[Number(a)] : it.tags.find((t) => hash4(t) === a);
        if (!name || (op === 'g' && hash4(name) !== b)) return answer('Tags changed, try again.');
        const tags = it.tags.includes(name) ? it.tags.filter((t) => t !== name) : [...it.tags, name];
        const updated = await update(id, { tags });
        invalidateStats();
        await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: cardText(updated, 'updated'), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: tagKeyboard(updated, names, 0) });
        return answer(tags.includes(name) ? `#${name} added` : `#${name} removed`);
      }
      case 'nc':
      case 'nt': {
        const it = await current();
        const kind = op === 'nc' ? 'collection' : 'tags';
        await say(chatId, `${op === 'nc' ? '📁 New collection' : '🏷 New tags'} for <a href="${troveLink(it.id, `&ask=${kind}`)}">${esc(it.title.slice(0, 80))}</a>\n${op === 'nc' ? 'Reply with a name, like <code>Dev/AI</code>.' : 'Reply with tags, separated by commas.'}`, {
          reply_markup: { force_reply: true, input_field_placeholder: op === 'nc' ? 'Collection name' : 'tag, another tag' },
        });
        return answer();
      }
      case 'b': {
        const it = await current();
        await editCard(chatId, messageId, it, 'updated');
        return answer();
      }
      case 'f':
      case 'r': {
        const it = await current();
        const updated = await update(id, op === 'f' ? { favorite: !it.favorite } : { read: !it.read });
        invalidateStats();
        await editCard(chatId, messageId, updated, 'updated');
        return answer(op === 'f' ? (updated.favorite ? '★ Favorite' : 'Removed from favorites') : updated.read ? 'Marked read' : 'Marked unread');
      }
      case 'd': {
        const it = await current();
        await remove(id);
        forget(id);
        invalidateStats();
        await editCard(chatId, messageId, it, 'deleted');
        return answer('Moved to the trash');
      }
      case 'u': {
        const it = await restore(id);
        invalidateStats();
        await editCard(chatId, messageId, it, 'saved');
        return answer('Restored');
      }
      case 'i': {
        const it = await current();
        await sendCard(chatId, it, 'updated');
        return answer();
      }
      case 'lc': {
        const names = await collectionNames();
        const name = names[Number(rawId)];
        if (!name || hash4(name) !== a) return answer('Collections changed, send /collections again.');
        const r = await list({ query: { collection: name }, limit: 8 });
        const m = listMessage(`📁 ${name}`, r.items, { label: 'Open in Trove', url: `${env().publicUrl}/?s=collection:${encodeURIComponent(name)}` });
        await say(chatId, m.text, { reply_markup: m.reply_markup });
        return answer();
      }
      case 'lt': {
        const names = await tagNames();
        const name = names[Number(rawId)];
        if (!name || hash4(name) !== a) return answer('Tags changed, send /tags again.');
        const r = await list({ query: { tags: [name] }, limit: 8 });
        const m = listMessage(`#${name}`, r.items, { label: 'Open in Trove', url: `${env().publicUrl}/?s=tag:${encodeURIComponent(name)}` });
        await say(chatId, m.text, { reply_markup: m.reply_markup });
        return answer();
      }
      default:
        return answer();
    }
  } catch (e: any) {
    return answer(`⚠️ ${e?.message || e}`.slice(0, 190), true);
  }
}

// ---------- commands ----------

let botName = '';
async function help(chatId: number, first = false) {
  if (!botName) botName = (await tg('getMe').catch(() => ({}))).username || '';
  const text = `${first ? '👋 <b>Trove is ready.</b> Everything you send here is saved to your library.\n\n' : ''}<b>Save</b>
• Send or forward a link, text, photo, video, voice note or file.
• Add <code>#tags</code>, <code>@Collection</code> (or <code>@"Two words"</code>), <code>!fav</code>, <code>!read</code>. The rest becomes the note.
• Nothing given? AI files it into your collections and writes a one-line summary.
• Reply to a card with <code>#tag</code>, <code>@Collection</code>, a note, or <code>/del</code>.

<b>Find</b>
• <code>? query</code> or /search: search by words and meaning
• <code>?? question</code> or /ask: answers from your library, with sources
• /recent · /later · /random · /collections · /tags · /stats
• In any chat: type <code>@${esc(botName || 'yourbot')}</code> and a query to share something you saved, or mention it in a reply to save that message.

<b>From anywhere</b>: in any app on iPhone, iPad or Mac, tap Share → Telegram → Trove.`;
  return say(chatId, text);
}

async function search(chatId: number, q: string) {
  tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  const r = await hybridSearch(q, 8);
  if (!r.items.length) return say(chatId, `No matches for “${esc(q)}”.`);
  const m = listMessage(`🔎 ${q}`, r.items.slice(0, 8), { label: 'See all in Trove', url: `${env().publicUrl}/?q=${encodeURIComponent(q)}` });
  return say(chatId, m.text, { reply_markup: m.reply_markup });
}

async function answer(chatId: number, question: string) {
  tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  const pending = await say(chatId, '🤔 Looking through your library…');
  try {
    const r = await ask(question);
    const body = esc(r.answer).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const sources = r.sources.map((s, i) => `${i + 1}. ${s.url ? `<a href="${esc(s.url)}">${esc(s.title.slice(0, 80))}</a>` : esc(s.title.slice(0, 80))}`).join('\n');
    const buttons = r.sources.map((s, i) => ({ text: String(i + 1), callback_data: `i:${short(s.id)}` }));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(buttons.slice(i, i + 5));
    return tg('editMessageText', { chat_id: chatId, message_id: pending.message_id, text: `${body}\n\n<b>Sources</b>\n${sources}`.slice(0, 4000), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: rows } });
  } catch (e: any) {
    return tg('editMessageText', { chat_id: chatId, message_id: pending.message_id, text: `⚠️ ${esc(e?.message || String(e))}`, parse_mode: 'HTML' });
  }
}

async function recent(chatId: number) {
  const r = await list({ limit: 8, source: 'library' });
  const m = listMessage('🕘 Recently saved', r.items, { label: 'Open Trove', url: env().publicUrl });
  return say(chatId, m.text, { reply_markup: m.reply_markup });
}

async function later(chatId: number) {
  const r = await list({ q: 'is:unread', limit: 60, source: 'library' });
  const pool = r.items.filter((i) => ['Article', 'Video', 'Paper', 'Post', 'Audio'].includes(i.type));
  const pick = (pool.length ? pool : r.items).sort(() => Math.random() - 0.5).slice(0, 5);
  const m = listMessage('📚 From your reading list', pick, { label: 'Read later in Trove', url: `${env().publicUrl}/?s=unread` });
  return say(chatId, m.text, { reply_markup: m.reply_markup });
}

async function random(chatId: number) {
  const sorts = ['newest', 'oldest', 'title', 'title_desc', 'site'] as const;
  const r = await list({ limit: 100, sort: sorts[Math.floor(Math.random() * sorts.length)] });
  const it = r.items[Math.floor(Math.random() * r.items.length)];
  if (!it) return say(chatId, 'Your library is empty.');
  return sendCard(chatId, it, 'updated', { note: '🎲 From your library' });
}

async function collectionsList(chatId: number) {
  const s = await stats();
  const names = await collectionNames();
  const counts = new Map(s.collections.map((c) => [c.name, c.count]));
  const top = names.slice(0, 24);
  const rows = [];
  for (let i = 0; i < top.length; i += 2) rows.push(top.slice(i, i + 2).map((n, j) => ({ text: `${n.split('/').join(' › ').slice(0, 28)} · ${counts.get(n)}`, callback_data: `lc:${i + j}:${hash4(n)}` })));
  return say(chatId, `<b>📁 Collections</b> (${names.length})\nTap one to see what’s in it.`, { reply_markup: { inline_keyboard: rows } });
}

async function tagsList(chatId: number) {
  const s = await stats();
  const top = s.tags.slice(0, 30);
  const rows = [];
  for (let i = 0; i < top.length; i += 3) rows.push(top.slice(i, i + 3).map((t, j) => ({ text: `#${t.name.slice(0, 18)} · ${t.count}`, callback_data: `lt:${i + j}:${hash4(t.name)}` })));
  return say(chatId, `<b>🏷 Tags</b> (${s.tags.length})`, { reply_markup: { inline_keyboard: rows } });
}

async function statsMessage(chatId: number) {
  const s = await stats({ fresh: true });
  const types = s.types.slice(0, 8).map((t) => `${t.name}: ${t.count.toLocaleString()}`).join(' · ');
  return say(chatId, `<b>📊 Your Trove</b>\n${s.total.toLocaleString()} items · ${s.collections.length} collections · ${s.tags.length} tags\n⭐ ${s.favorites} favorites · 🖍 ${s.highlights} with highlights · 📥 ${s.unsorted} unsorted\n${esc(types)}`);
}

// ---------- inline mode and guest mode ----------

async function onInline(q: any) {
  if (!allowed(q.from?.id)) return tg('answerInlineQuery', { inline_query_id: q.id, results: [], cache_time: 300, is_personal: true }).catch(() => {});
  const query = String(q.query || '').trim();
  const items = query ? (await hybridSearch(query, 15)).items : (await list({ limit: 15, source: 'library' })).items;
  const results = items.slice(0, 15).map((it) => ({
    type: 'article',
    id: short(it.id),
    title: it.title || it.url,
    description: (it.summary || it.excerpt || it.domain || '').slice(0, 200),
    url: it.url || undefined,
    hide_url: false,
    ...(it.cover && /^https:/.test(it.cover) ? { thumbnail_url: it.cover } : it.domain ? { thumbnail_url: `https://www.google.com/s2/favicons?domain=${it.domain}&sz=128` } : {}),
    input_message_content: { message_text: it.url ? `<b>${esc(it.title)}</b>\n${esc(it.url)}` : `<b>${esc(it.title)}</b>\n\n${esc((it.excerpt || '').slice(0, 3000))}`, parse_mode: 'HTML' },
  }));
  return tg('answerInlineQuery', { inline_query_id: q.id, results, cache_time: 10, is_personal: true });
}

/** Someone (you) mentioned the bot in another chat: save that message, or the one it replies to. */
async function onGuest(msg: any) {
  if (!allowed(msg.from?.id)) return;
  const target = msg.reply_to_message || msg;
  const owner = msg.from.id;
  const text = String(msg.text || msg.caption || '').replace(/@\w+bot\b/gi, '').trim();
  const d = parseDirectives(text);
  const urls = [...linksIn(target), ...(target === msg ? [] : linksIn(msg))];
  const known = await collectionNames();
  const base: Partial<SaveInput> = { tags: d.tags.length ? d.tags : undefined, collection: d.collection ? resolveCollection(d.collection, known) : undefined, favorite: d.favorite || undefined, source: VIA, via: VIA };
  const chatTitle = msg.chat?.title || msg.chat?.username || [msg.chat?.first_name, msg.chat?.last_name].filter(Boolean).join(' ');
  const from = target.from ? [target.from.first_name, target.from.last_name].filter(Boolean).join(' ') : '';
  const context = `From ${from || 'a message'}${chatTitle ? ` in ${chatTitle}` : ''}`;
  try {
    const results: SaveResult[] = [];
    if (urls.length) for (const url of urls.slice(0, 5)) results.push(await save({ ...base, url, note: [d.rest, context].filter(Boolean).join('\n\n') } as SaveInput));
    else {
      const body = String(target.text || target.caption || '').trim();
      if (!body) throw new Error('Mention me in a reply to a message with a link or text to save it.');
      results.push(await save({ ...base, text: `${body}\n\n— ${context}`, note: d.rest || undefined } as SaveInput));
    }
    invalidateStats();
    for (const r of results) {
      const sent = await sendCard(owner, r.item, r.created ? 'filing' : 'exists');
      const e = r.created ? await afterSave(r, base as SaveInput).catch(() => null) : null;
      if (e) await editCard(owner, sent.message_id, e.item, 'saved', { filed: !!e.filed?.collection, archived: !!(e.snapshot || e.archive) });
      else if (r.created) await editCard(owner, sent.message_id, r.item, 'saved');
    }
    if (msg.guest_query_id) {
      await tg('answerGuestQuery', {
        guest_query_id: msg.guest_query_id,
        result: { type: 'article', id: 'saved', title: 'Saved to Trove', input_message_content: { message_text: `📥 Saved to Trove${results.length > 1 ? ` (${results.length})` : ''}` } },
      }).catch(() => {});
    }
  } catch (e: any) {
    await say(owner, `⚠️ Couldn’t save from ${esc(chatTitle || 'that chat')}: ${esc(e?.message || String(e))}`).catch(() => {});
  }
}

// ---------- setup ----------

export const BOT_COMMANDS = [
  { command: 'search', description: 'Search your library (words and meaning)' },
  { command: 'ask', description: 'Ask a question, answered from what you saved' },
  { command: 'recent', description: 'Recently saved' },
  { command: 'later', description: 'Something from your reading list' },
  { command: 'random', description: 'A random item from your library' },
  { command: 'collections', description: 'Browse collections' },
  { command: 'tags', description: 'Browse tags' },
  { command: 'stats', description: 'Library stats' },
  { command: 'help', description: 'How to save and find things' },
];

/** Point Telegram at this deployment and set the bot's commands and descriptions. */
export async function setupBot() {
  const cfg = telegramConfig();
  if (!cfg) throw new Error('Set TELEGRAM_BOT_TOKEN first');
  if (!cfg.secret) throw new Error('Set TELEGRAM_WEBHOOK_SECRET first');
  const url = `${env().publicUrl}/api/telegram`;
  await tg('setWebhook', { url, secret_token: cfg.secret, allowed_updates: ['message', 'callback_query', 'inline_query', 'guest_message'], max_connections: 10 });
  await tg('setMyCommands', { commands: BOT_COMMANDS });
  await tg('setMyShortDescription', { short_description: 'Save anything to your Trove library: links, notes, photos, files. Search and ask it too.' }).catch(() => {});
  await tg('setMyDescription', {
    description: 'Send or forward anything (links, text, photos, videos, voice notes, files) and it’s saved to your Trove library, filed into collections and archived. Use #tags and @Collection, search with ? or ask with ??.',
  }).catch(() => {});
  const [me, info] = await Promise.all([tg('getMe'), tg('getWebhookInfo')]);
  return { bot: me.username, webhook: info.url, pending: info.pending_update_count, lastError: info.last_error_message || null, inline: !!me.supports_inline_queries, guest: !!me.supports_guest_queries };
}
