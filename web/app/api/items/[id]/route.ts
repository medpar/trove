import { guarded, json } from '@/lib/auth';
import { readBody } from '@/lib/input';
import { forget } from '@/lib/semantic';
import { getItem, invalidateStats, remove, update } from '@/lib/store';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/items/:id?content=1  -> item (+ archived Markdown content) */
export const GET = guarded<Ctx>(async (req, _who, { params }) => {
  const { id } = await params;
  const content = /^(1|true)$/.test(new URL(req.url).searchParams.get('content') || '');
  return json(await getItem(id, { content }));
});

/** PATCH /api/items/:id  {title, tags, collection, note, favorite, read, remind, url, progress (0-100), summary} */
export const PATCH = guarded<Ctx>(async (req, _who, { params }) => {
  const { id } = await params;
  const body = await readBody(req);
  const tags = Array.isArray(body.tags) ? body.tags : typeof body.tags === 'string' ? body.tags.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined;
  const item = await update(id, {
    title: body.title,
    tags,
    collection: body.collection === '' ? null : body.collection,
    note: body.note,
    favorite: body.favorite,
    read: body.read,
    remind: body.remind,
    url: body.url,
    progress: typeof body.progress === 'number' ? body.progress : undefined,
    summary: typeof body.summary === 'string' ? body.summary : undefined,
  });
  invalidateStats();
  return json({ item });
});

/** DELETE /api/items/:id  -> moves the Notion page to the trash (recoverable) */
export const DELETE = guarded<Ctx>(async (_req, _who, { params }) => {
  const { id } = await params;
  await remove(id);
  forget(id);
  invalidateStats();
  return json({ ok: true });
});
