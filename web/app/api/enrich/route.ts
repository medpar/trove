import { guarded, json } from '@/lib/auth';
import { aiStatus } from '@/lib/ai';
import { enrich, enrichPending } from '@/lib/enrich';
import { readBody } from '@/lib/input';

export const maxDuration = 300;

/** GET: AI status. POST {id, autofile?} re-runs OCR, filing, summary, embedding and archive for one item; {pending: true, limit} processes items never enriched. */
export const GET = guarded(async () => json(aiStatus()));

export const POST = guarded(async (req) => {
  const body = await readBody(req);
  if (body.id) return json(await enrich(String(body.id), { autofile: body.autofile === true, archive: body.archive !== false }));
  if (body.pending) return json(await enrichPending({ limit: Math.min(Number(body.limit) || 20, 60), archive: body.archive !== false }));
  return json({ error: 'Pass {id} or {pending: true}' }, { status: 400 });
});
