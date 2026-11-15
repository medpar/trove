import { guarded, json } from '@/lib/auth';
import { readBody } from '@/lib/input';
import { connectSpotify, connectYouTube, disconnect, syncStatus } from '@/lib/media-sync';

export const maxDuration = 60;

/** GET /api/media/connect -> which sign-ins the server sync has and when it last ran */
export const GET = guarded(async () => json(await syncStatus()));

/**
 * POST /api/media/connect {spotify: "<sp_dc cookie>"} or {youtube: "<cookies.txt | Cookie header | JSON export>"}
 * Checked against Spotify / YouTube, then kept encrypted. Use a private-window sign-in for YouTube.
 */
export const POST = guarded(async (req) => {
  const b = await readBody(req);
  const out: Record<string, unknown> = {};
  if (typeof b.spotify === 'string' && b.spotify.trim()) out.spotify = await connectSpotify(b.spotify);
  if ((typeof b.youtube === 'string' && b.youtube.trim()) || (b.youtube && typeof b.youtube === 'object')) out.youtube = await connectYouTube(b.youtube);
  if (!Object.keys(out).length) return json({ error: 'Pass {spotify: "<sp_dc>"} or {youtube: "<cookies>"}' }, { status: 400 });
  return json({ ...out, status: await syncStatus() });
});

/** DELETE /api/media/connect?which=spotify|youtube -> forget that sign-in */
export const DELETE = guarded(async (req) => {
  const which = new URL(req.url).searchParams.get('which');
  if (which !== 'spotify' && which !== 'youtube') return json({ error: 'Pass ?which=spotify|youtube' }, { status: 400 });
  await disconnect(which);
  return json({ ok: true, status: await syncStatus() });
});
