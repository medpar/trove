import { after } from 'next/server';
import { caller, json, unauthorized } from '@/lib/auth';
import { env } from '@/lib/env';
import { syncAll } from '@/lib/media-sync';

export const maxDuration = 300;

async function handle(req: Request) {
  const cron = env().cronSecret && req.headers.get('authorization') === `Bearer ${env().cronSecret}`;
  if (!cron && !caller(req)) return unauthorized();
  const sp = new URL(req.url).searchParams;
  const deep = /^(1|true)$/.test(sp.get('deep') || '');
  const o = sp.get('only');
  const only = o === 'spotify' || o === 'youtube' || o === 'shows' ? o : undefined;
  // Shortcuts and automations shouldn't wait: answer now and sync right after, unless ?wait=1.
  if (!/^(1|true)$/.test(sp.get('wait') || '')) {
    after(() => syncAll({ deep, only }).catch(() => {}));
    return json({ ok: true, started: true }, { status: 202 });
  }
  return json(await syncAll({ deep, only, deadline: Date.now() + 270_000 }));
}

/**
 * POST /api/media/sync?wait=1&deep=1&only=spotify|youtube|shows
 * Read what you played on Spotify and YouTube on any device (iPhone, iPad, apps) through the
 * sign-ins saved in Settings, and refresh one followed show. Hourly from the Cloudflare worker,
 * and from an iOS automation when you close the Spotify or YouTube app.
 */
export const POST = handle;
export const GET = handle;
