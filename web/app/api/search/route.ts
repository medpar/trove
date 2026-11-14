import { guarded, json } from '@/lib/auth';
import { hybridSearch } from '@/lib/semantic';

export const maxDuration = 60;

/** GET /api/search?q=&limit=  Hybrid search: keyword matches plus items that mean the same thing. */
export const GET = guarded(async (req) => {
  const p = new URL(req.url).searchParams;
  const q = p.get('q') || '';
  return json(await hybridSearch(q, Math.min(Number(p.get('limit')) || 40, 60)));
});
