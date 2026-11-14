import { guarded, json } from '@/lib/auth';
import { related } from '@/lib/semantic';

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/items/:id/related?limit=8  Items closest in meaning (needs the item's embedding). */
export const GET = guarded<Ctx>(async (req, _who, { params }) => {
  const { id } = await params;
  const limit = Math.min(Number(new URL(req.url).searchParams.get('limit')) || 8, 20);
  return json({ items: await related(id, limit) });
});
