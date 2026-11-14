// GitHub stars: every repo you star lands in the "GitHub stars" collection with its README
// archived. Runs twice a day (crons) and on demand from Settings.
//   GITHUB_STARS_USER   GitHub username whose stars to sync
//   GITHUB_TOKEN        optional; lifts the 60 requests/hour limit shared by Vercel's IPs
// The starred list costs one API request per 100 stars and nothing when unchanged (ETag);
// READMEs come from raw.githubusercontent.com, which doesn't count against the API limit.
import 'server-only';
import { githubHeaders, githubRepo } from './extract';
import { GITHUB_COLLECTION } from './library-schema.js';
import { invalidateStats, save } from './store';
import { readState, stateReady, writeState } from './state';

export type StarsState = {
  user: string;
  etag?: string;
  newest?: string;
  backfillPage: number;
  backfillDone: boolean;
  synced: number;
  lastRun?: string;
  lastError?: string | null;
  rateLimit?: { remaining: number; reset: string } | null;
};

export const starsConfig = () => {
  const user = process.env.GITHUB_STARS_USER?.trim();
  return user ? { user, token: !!process.env.GITHUB_TOKEN?.trim() } : null;
};

type Star = { starred_at: string; repo: any };

async function page(user: string, n: number, etag?: string) {
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(user)}/starred?per_page=100&page=${n}`, {
    headers: { ...githubHeaders('application/vnd.github.star+json'), 'user-agent': 'trove-stars-sync', ...(etag ? { 'if-none-match': etag } : {}) },
    signal: AbortSignal.timeout(20000),
  });
  const rateLimit = res.headers.get('x-ratelimit-remaining')
    ? { remaining: Number(res.headers.get('x-ratelimit-remaining')), reset: new Date(Number(res.headers.get('x-ratelimit-reset')) * 1000).toISOString() }
    : null;
  const last = Number(/[?&]page=(\d+)>;\s*rel="last"/.exec(res.headers.get('link') || '')?.[1]) || n;
  if (res.status === 304) return { status: 304, stars: [] as Star[], etag, rateLimit, last };
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    throw Object.assign(new Error(res.status === 403 || res.status === 429 ? `GitHub rate limit reached; it resets at ${rateLimit?.reset || 'the top of the hour'}. Set GITHUB_TOKEN to avoid it.` : `GitHub ${res.status}: ${body.message || res.statusText}`), { rateLimit });
  }
  return { status: 200, stars: (await res.json()) as Star[], etag: res.headers.get('etag') || undefined, rateLimit, last };
}

export async function starsStatus(): Promise<StarsState | null> {
  return readState<StarsState>('github-stars.json');
}

/** Save new stars (and, on the first runs, all older ones) into the GitHub stars collection. */
export async function syncStars({ deadline = Date.now() + 200_000, max = 150 } = {}) {
  const cfg = starsConfig();
  if (!cfg) return { configured: false as const };
  if (!stateReady()) throw new Error('GitHub stars sync keeps its progress in Vercel Blob; connect a Blob store first');
  let state = (await starsStatus()) || null;
  if (!state || state.user !== cfg.user) state = { user: cfg.user, backfillPage: 0, backfillDone: false, synced: 0 };
  let saved = 0;
  let merged = 0;
  const errors: string[] = [];
  const store = async (stars: Star[]) => {
    // Oldest first, so the library's newest-first order matches the order you starred them.
    const list = [...stars].sort((a, b) => a.starred_at.localeCompare(b.starred_at));
    let next = 0;
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (next < list.length) {
          const s = list[next++];
          try {
            const extracted = await githubRepo(s.repo);
            const r = await save({ url: s.repo.html_url, collection: GITHUB_COLLECTION, source: 'GitHub', via: 'GitHub stars', extracted, bookmarked: s.starred_at, autofile: false });
            if (r.created) saved++;
            else merged++;
          } catch (e: any) {
            errors.push(`${s.repo?.full_name}: ${e?.message || e}`);
          }
        }
      }),
    );
    return list.reduce((m, s) => (s.starred_at > m ? s.starred_at : m), '');
  };
  try {
    if (!state.backfillDone) {
      // First sync: from the oldest page to the newest, one page per step; resumes where it stopped.
      const first = await page(cfg.user, 1);
      state.rateLimit = first.rateLimit;
      if (!state.backfillPage) state.backfillPage = first.last;
      while (state.backfillPage >= 1 && Date.now() < deadline - 45_000 && saved + merged < max) {
        const p = state.backfillPage === 1 ? first : await page(cfg.user, state.backfillPage);
        const newest = await store(p.stars);
        if (errors.length) break;
        if (newest > (state.newest || '')) state.newest = newest;
        state.backfillPage--;
      }
      if (state.backfillPage < 1) {
        state.backfillDone = true;
        state.etag = first.etag;
      }
    } else {
      // Afterwards: only the first page, and a 304 when nothing was starred since last time.
      const p1 = await page(cfg.user, 1, state.etag);
      state.rateLimit = p1.rateLimit;
      if (p1.status === 200) {
        const fresh = p1.stars.filter((s) => !state.newest || s.starred_at > state.newest!);
        const newest = await store(fresh);
        // Remember the ETag and newest star only once everything up to it is saved.
        if (!errors.length) {
          state.etag = p1.etag;
          if (newest > (state.newest || '')) state.newest = newest;
        }
      }
    }
    state.lastError = errors[0] || null;
  } catch (e: any) {
    state.lastError = e?.message || String(e);
    if (e?.rateLimit) state.rateLimit = e.rateLimit;
  }
  state.synced += saved;
  state.lastRun = new Date().toISOString();
  await writeState('github-stars.json', state);
  if (saved || merged) invalidateStats();
  return { configured: true as const, saved, merged, backfillDone: state.backfillDone, error: state.lastError, errors: errors.slice(0, 5) };
}
