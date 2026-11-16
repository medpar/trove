import { guarded, json } from '@/lib/auth';
import { applyEvents, type EpisodeEvent } from '@/lib/episodes';
import { readBody } from '@/lib/input';
import { withCatalog } from '@/lib/shows';

export const maxDuration = 60;

const P = new Set(['yt', 'sp']);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Accept only what an event may carry (ranges in seconds, positions, what the platform reported). */
function clean(e: any): EpisodeEvent | null {
  if (!e || !P.has(e.p) || !/^[\w-]{11,22}$/.test(e.id || '')) return null;
  const ranges = Array.isArray(e.ranges) ? e.ranges.filter((r: any) => Array.isArray(r) && r.length === 2 && r.every((x: any) => typeof x === 'number' && Number.isFinite(x) && x >= 0)).slice(0, 200) : undefined;
  const extDur = e.ext && num(e.ext.dur);
  const ext = e.ext && typeof e.ext === 'object' ? { pos: Math.max(0, num(e.ext.pos) ?? 0), done: e.ext.done === true, dur: extDur && extDur > 0 ? extDur : undefined, seen: e.ext.seen === true || undefined } : undefined;
  const twinDur = e.twin && num(e.twin.dur);
  const twin = e.twin && P.has(e.twin.p) && /^[\w-]{11,22}$/.test(e.twin.id || '') ? { p: e.twin.p, id: e.twin.id, by: str(e.twin.by, 30) || 'client', score: num(e.twin.score), dur: twinDur && twinDur > 0 ? twinDur : undefined, title: str(e.twin.title, 300) } : null;
  const at = num(e.at);
  const dur = num(e.dur);
  const since = num(e.since);
  return {
    p: e.p,
    id: e.id,
    at: at && at <= Date.now() + 60_000 ? at : Date.now(),
    title: str(e.title, 300),
    show: str(e.show, 200),
    showId: str(e.showId, 40),
    channel: str(e.channel, 200),
    channelId: str(e.channelId, 40),
    image: str(e.image, 600),
    released: str(e.released, 40),
    dur: dur && dur > 0 ? dur : undefined,
    ranges,
    since: since && since <= Date.now() + 60_000 ? since : undefined,
    pos: num(e.pos),
    ext,
    src: str(e.src, 30) || 'api',
    before: e.before === true || undefined,
    twin,
  };
}

/**
 * POST /api/media/events {events: [{p: "yt"|"sp", id, at, title?, show?|channel?, dur?, ranges?: [[s,e]], since?, pos?, ext?: {pos, done}, twin?}]}
 * `since`: when the player started (its ranges are everything it played since then).
 * Progress from players (the extension), Shortcuts or agents. Idempotent: sending the same thing twice changes nothing.
 */
export const POST = guarded(async (req) => {
  const body = await readBody(req);
  const events = (Array.isArray(body.events) ? body.events : [body]).map(clean).filter(Boolean).slice(0, 50) as EpisodeEvent[];
  if (!events.length) return json({ error: 'Pass events: [{p: "yt"|"sp", id, ...}]' }, { status: 400 });
  try {
    return json({ cards: await applyEvents(await withCatalog(events)) });
  } catch (e: any) {
    // Notion trouble is temporary for the sender: it keeps the events and retries.
    throw Object.assign(new Error(`Couldn't store progress: ${e?.message || e}`), { status: 502 });
  }
});
