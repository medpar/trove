import { caller, json, unauthorized } from '@/lib/auth';
import { env } from '@/lib/env';
import { cleanupUploads } from '@/lib/files';
import { syncStars } from '@/lib/github';
import { checkLinks } from '@/lib/store';

export const maxDuration = 300;

/** Daily broken-link check, cleanup of unfinished uploads and a GitHub stars sync (Vercel Cron sends Authorization: Bearer $CRON_SECRET). */
export async function GET(req: Request) {
  const cron = env().cronSecret && req.headers.get('authorization') === `Bearer ${env().cronSecret}`;
  if (!cron && !caller(req)) return unauthorized();
  const uploads = await cleanupUploads().catch((e) => ({ error: (e as Error).message }));
  // A second GitHub stars pass each day (the daily cron runs one too).
  const stars = await syncStars({ deadline: Date.now() + 90_000 }).catch((e) => ({ error: (e as Error).message }));
  return json({ ...(await checkLinks(Number(new URL(req.url).searchParams.get('limit')) || 100)), uploads, stars });
}
