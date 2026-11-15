import { after } from 'next/server';
import { guarded, json } from '@/lib/auth';
import { readBody } from '@/lib/input';
import { spotifyCreds } from '@/lib/media-sync';
import { buildCatalog, getShow, setupShow, showPlaylists, showView, unfollowShow, updateShow } from '@/lib/shows';

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/media/shows/:id -> {show, catalog, series, episodes} ; ?playlists=1 -> the channel's playlists */
export const GET = guarded<Ctx>(async (req, _who, { params }) => {
  const { id } = await params;
  if (new URL(req.url).searchParams.get('playlists')) return json({ playlists: await showPlaylists(id) });
  return json(await showView(id));
});

/** PATCH /api/media/shows/:id {title, rules: [{series, pattern}], playlists: [{id, title, series}], uploads, link: {sp, yt}, unlink: {sp, yt}} */
export const PATCH = guarded<Ctx>(async (req, _who, { params }) => {
  const { id } = await params;
  const b = await readBody(req);
  const pair = (x: any) => (x && typeof x.sp === 'string' && typeof x.yt === 'string' ? { sp: x.sp, yt: x.yt } : undefined);
  const show = await updateShow(id, {
    title: typeof b.title === 'string' ? b.title : undefined,
    rules: Array.isArray(b.rules) ? b.rules : undefined,
    playlists: Array.isArray(b.playlists) ? b.playlists : undefined,
    uploads: typeof b.uploads === 'boolean' ? b.uploads : undefined,
    link: pair(b.link),
    unlink: pair(b.unlink),
  });
  return json({ show });
});

/** POST /api/media/shows/:id?action=refresh|setup -> rebuild the catalog now (setup also re-picks series playlists) */
export const POST = guarded<Ctx>(async (req, _who, { params }) => {
  const { id } = await params;
  const action = new URL(req.url).searchParams.get('action') || 'refresh';
  const spDc = (await spotifyCreds())?.spDc || null;
  const show = await getShow(id);
  if (action === 'setup') {
    after(() => setupShow(id, { spDc }).catch(() => {}));
    return json({ ok: true, building: true }, { status: 202 });
  }
  const c = await buildCatalog(show, { spDc, deadline: Date.now() + 240_000 });
  return json({ ok: true, spotify: c.sp.length, youtube: c.yt.length, paired: Object.keys(c.pairs).length, error: c.error || null });
});

/** DELETE /api/media/shows/:id -> stop following (your episodes stay in Notion) */
export const DELETE = guarded<Ctx>(async (_req, _who, { params }) => {
  const { id } = await params;
  await unfollowShow(id);
  return json({ ok: true });
});
