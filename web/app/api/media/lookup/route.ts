import { guarded, json } from '@/lib/auth';
import { lookupRefs, refOf } from '@/lib/episodes';

/**
 * GET /api/media/lookup?url=<YouTube or Spotify link>&ref=yt:<id>…  -> {results: {<input>: card|null}}
 * Have I seen this? Status, how much, and where to resume, whichever platform it was played on.
 */
export const GET = guarded(async (req) => {
  const sp = new URL(req.url).searchParams;
  const inputs = [...sp.getAll('url'), ...sp.getAll('ref')].filter(Boolean).slice(0, 50);
  if (!inputs.length) return json({ error: 'Pass ?url= (YouTube or Spotify link) or ?ref=yt:<id>|sp:<id>' }, { status: 400 });
  const refs = new Map(inputs.map((i) => [i, refOf(i)]));
  const found = await lookupRefs([...new Set([...refs.values()].filter(Boolean).map((r) => `${r!.p}:${r!.id}`))]);
  const results = Object.fromEntries(inputs.map((i) => {
    const r = refs.get(i);
    return [i, r ? found[`${r.p}:${r.id}`] || null : null];
  }));
  return json({ results });
});
