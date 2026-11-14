// Normalize save requests coming from the web app, extension, Shortcuts, bookmarklets and agents.
import type { Caller } from './auth';
import type { SaveInput } from './store';

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function sourceFor(who: Caller, explicit?: string) {
  if (explicit) return explicit;
  if (who.kind === 'session') return 'Web app';
  if (/shortcut|ios|mac/i.test(who.via)) return 'Shortcut';
  if (/extension|brave|chrome/i.test(who.via)) return 'Extension';
  if (/raycast/i.test(who.via)) return 'Raycast';
  if (/telegram/i.test(who.via)) return 'Telegram';
  return 'Agent';
}

export function toSaveInput(raw: any, who: Caller): SaveInput {
  const r = raw || {};
  const url = str(r.url) || str(r.link) || str(r.href);
  return {
    url,
    text: str(r.text) || str(r.content) || str(r.body),
    title: str(r.title),
    note: str(r.note) || str(r.comment),
    tags: list(r.tags),
    collection: r.collection === null ? null : str(r.collection) || str(r.folder),
    highlight: str(r.highlight) || str(r.selection),
    type: str(r.type),
    favorite: r.favorite === true || r.favorite === 'true' || r.important === true,
    read: r.read === true || r.read === 'true',
    remind: str(r.remind) || null,
    meta: r.meta && typeof r.meta === 'object' ? r.meta : undefined,
    source: sourceFor(who, str(r.source)),
    via: str(r.via) || (who.kind === 'key' ? who.via : undefined),
    archive: r.archive === false || r.archive === 'false' ? false : undefined,
    autofile: r.autofile === false || r.autofile === 'false' ? false : undefined,
  };
}

/** Accepts JSON, form posts and query strings (bookmarklets, Shortcuts, curl). */
export async function readBody(req: Request): Promise<any> {
  const type = req.headers.get('content-type') || '';
  if (type.includes('application/json')) return req.json().catch(() => ({}));
  if (type.includes('form')) return Object.fromEntries((await req.formData()).entries());
  const text = await req.text().catch(() => '');
  if (!text) return Object.fromEntries(new URL(req.url).searchParams.entries());
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}
