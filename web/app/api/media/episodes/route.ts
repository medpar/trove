import { guarded, json } from '@/lib/auth';
import { listEpisodes } from '@/lib/episodes';

/** GET /api/media/episodes?status=started|finished&show=&limit=&cursor=  -> {cards, cursor} (latest played first) */
export const GET = guarded(async (req) => {
  const sp = new URL(req.url).searchParams;
  const status = sp.get('status');
  return json(
    await listEpisodes({
      status: status === 'started' || status === 'finished' || status === 'new' ? status : undefined,
      show: sp.get('show') || undefined,
      cursor: sp.get('cursor'),
      limit: Number(sp.get('limit')) || 50,
      sort: sp.get('sort') === 'released' ? 'released' : 'last',
    }),
  );
});
