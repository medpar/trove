import { caller, json, unauthorized } from '@/lib/auth';
import { enrichPending } from '@/lib/enrich';
import { env } from '@/lib/env';
import { autosaveFeeds } from '@/lib/feeds';
import { syncStars } from '@/lib/github';
import { rebuildIndex } from '@/lib/semantic';

export const maxDuration = 300;

/**
 * Daily: save new posts from auto-save feeds and new GitHub stars, enrich items that came in without the pipeline
 * (X sync, Pinterest, imports, feeds) and rebuild the search index cache.
 */
export async function GET(req: Request) {
  const cron = env().cronSecret && req.headers.get('authorization') === `Bearer ${env().cronSecret}`;
  if (!cron && !caller(req)) return unauthorized();
  const started = Date.now();
  const feeds = await autosaveFeeds().catch((e) => ({ error: (e as Error).message }));
  const stars = await syncStars({ deadline: started + 90_000 }).catch((e) => ({ error: (e as Error).message }));
  const enriched = await enrichPending({ limit: 60, deadline: started + 200_000 }).catch((e) => ({ error: (e as Error).message }));
  const index = await rebuildIndex().catch((e) => ({ error: (e as Error).message }));
  return json({ feeds, stars, enriched, index, ms: Date.now() - started });
}
