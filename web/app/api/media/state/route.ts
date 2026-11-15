import { guarded, json } from '@/lib/auth';
import { listEpisodes } from '@/lib/episodes';

export const maxDuration = 60;

/**
 * GET /api/media/state?since=<ISO>&cursor=  -> {cards, cursor, now}
 * Every episode edited since a time (oldest first, 100 per page), for clients that keep their own copy
 * (the extension marks videos from it). Pass the previous `now` as `since` next time.
 */
export const GET = guarded(async (req) => {
  const sp = new URL(req.url).searchParams;
  const now = new Date(Date.now() - 2 * 60_000).toISOString(); // Notion edit times are rounded to the minute
  const { cards, cursor } = await listEpisodes({ since: sp.get('since') || null, cursor: sp.get('cursor'), sort: 'edited' });
  return json({ cards, cursor, now });
});
