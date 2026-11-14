import { after } from 'next/server';
import { guarded, json } from '@/lib/auth';
import { afterSave } from '@/lib/enrich';
import { readBody, toSaveInput } from '@/lib/input';
import { invalidateStats, list, save, type Sort } from '@/lib/store';
import { normalizeType } from '@/lib/query';

export const maxDuration = 300;

/** GET /api/items?q=&collection=&tag=&type=&favorite=1&unread=1&source=all|library|x&sort=newest&cursor=&limit= */
export const GET = guarded(async (req) => {
  const p = new URL(req.url).searchParams;
  const flag = (k: string) => (p.has(k) ? /^(1|true|yes)$/i.test(p.get(k)!) : undefined);
  const collection = p.get('collection');
  const res = await list({
    q: p.get('q') || '',
    sort: (p.get('sort') as Sort) || 'newest',
    cursor: p.get('cursor'),
    limit: Number(p.get('limit')) || 40,
    source: (p.get('source') as 'all' | 'library' | 'x') || 'all',
    query: {
      ...(collection !== null ? { collection: collection === '' || collection === 'unsorted' ? null : collection } : {}),
      ...(p.get('tag') ? { tags: [p.get('tag')!] } : {}),
      ...(p.get('type') ? { types: [normalizeType(p.get('type')!)] } : {}),
      ...(p.get('platform') ? { platform: p.get('platform')! } : {}),
      ...(flag('favorite') !== undefined ? { favorite: flag('favorite') } : {}),
      ...(flag('unread') ? { read: false } : {}),
      ...(flag('broken') ? { broken: true } : {}),
      ...(flag('highlights') ? { hasHighlights: true } : {}),
      ...(flag('notes') ? { hasNote: true } : {}),
      ...(flag('reminders') ? { reminder: true } : {}),
      ...(flag('notag') ? { noTags: true } : {}),
    },
  });
  return json(res);
});

/** POST /api/items  {url|text, title, note, tags, collection, highlight, favorite, read, remind, meta}  or {items:[...]} (max 25) */
export const POST = guarded(async (req, who) => {
  const body = await readBody(req);
  const batch: any[] = Array.isArray(body?.items) ? body.items.slice(0, 25) : null;
  if (!batch) {
    const input = toSaveInput(body, who);
    const r = await save(input);
    invalidateStats();
    after(() => afterSave(r, input).catch((e) => console.error('enrich', e)));
    return json(r, { status: r.created ? 201 : 200 });
  }
  const results: any[] = new Array(batch.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, batch.length) }, async () => {
      while (next < batch.length) {
        const i = next++;
        try {
          const input = toSaveInput(batch[i], who);
          results[i] = await save(input);
          const r = results[i];
          after(() => afterSave(r, input).catch((e) => console.error('enrich', e)));
        } catch (e: any) {
          results[i] = { error: e?.message || String(e), input: batch[i]?.url || batch[i]?.text?.slice(0, 80) };
        }
      }
    }),
  );
  invalidateStats();
  return json({ results });
});
