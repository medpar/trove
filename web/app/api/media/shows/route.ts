import { after } from 'next/server';
import { guarded, json } from '@/lib/auth';
import { listEpisodes } from '@/lib/episodes';
import { readBody } from '@/lib/input';
import { spotifyCreds } from '@/lib/media-sync';
import { followShow, listShows, readCatalog, setupShow } from '@/lib/shows';

export const maxDuration = 300;

/** GET /api/media/shows -> {shows, continue: in-progress episodes (latest first), finished: recently finished} */
export const GET = guarded(async () => {
  const [shows, cont, fin] = await Promise.all([listShows(true), listEpisodes({ status: 'started', limit: 30 }), listEpisodes({ status: 'finished', limit: 12 })]);
  const withCatalog = await Promise.all(shows.map(async (s) => {
    const c = await readCatalog(s.id);
    return { ...s, catalog: c ? { at: c.at, episodes: c.sp.length || c.yt.length, error: c.error || null } : null };
  }));
  return json({ shows: withCatalog, continue: cont.cards, finished: fin.cards });
});

/**
 * POST /api/media/shows {spotify: "<show link>", youtube: "<channel, @handle or playlist link>", title?}
 * Follow a show. Its catalog (both platforms, paired, series from the channel's playlists) builds in the background.
 */
export const POST = guarded(async (req) => {
  const b = await readBody(req);
  const spDc = (await spotifyCreds())?.spDc || null;
  const show = await followShow({ spotify: b.spotify || undefined, youtube: b.youtube || undefined, title: b.title || undefined }, { spDc });
  after(() => setupShow(show.id, { spDc }).catch(() => {}));
  return json({ show, building: true }, { status: 201 });
});
