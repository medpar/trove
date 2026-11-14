import { guarded, json } from '@/lib/auth';
import { starsConfig, starsStatus, syncStars } from '@/lib/github';

export const maxDuration = 300;

/** GET: GitHub stars sync status. POST: sync now (new stars, or the next part of the first sync). */
export const GET = guarded(async () => json({ config: starsConfig(), state: await starsStatus() }));

export const POST = guarded(async () => json(await syncStars({ deadline: Date.now() + 240_000 })));
