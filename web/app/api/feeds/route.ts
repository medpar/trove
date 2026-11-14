import { guarded, json } from '@/lib/auth';
import { importOpml, readEntries, subscribe, unsubscribe, updateFeed } from '@/lib/feeds';
import { readBody } from '@/lib/input';

export const maxDuration = 60;

/** GET /api/feeds?feed=<id>  ->  {feeds, entries} (newest first, read live and cached for a few minutes) */
export const GET = guarded(async (req) => json(await readEntries(new URL(req.url).searchParams.get('feed') || undefined)));

/** POST /api/feeds {url, collection?, autosave?} subscribes (finds the feed of a page); {opml: "<xml>"} imports a list. */
export const POST = guarded(async (req) => {
  const b = await readBody(req);
  if (b.opml) return json(await importOpml(String(b.opml)));
  if (!b.url) return json({ error: 'Pass the url of a feed or a site' }, { status: 400 });
  return json({ feed: await subscribe(String(b.url), { collection: b.collection || null, autosave: b.autosave === true }) }, { status: 201 });
});

/** PATCH /api/feeds {id, title?, collection?, autosave?} */
export const PATCH = guarded(async (req) => {
  const b = await readBody(req);
  return json({ feed: await updateFeed(String(b.id), { title: b.title, collection: b.collection === '' ? null : b.collection, autosave: typeof b.autosave === 'boolean' ? b.autosave : undefined }) });
});

/** DELETE /api/feeds?id= */
export const DELETE = guarded(async (req) => {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return json({ error: 'Pass ?id=' }, { status: 400 });
  await unsubscribe(id);
  return json({ ok: true });
});
