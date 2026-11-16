// What Trove says about a YouTube or Spotify link (the Telegram bot's reply when you share one).
import { clock, mapPosition, watchUrl } from '../../extension/lib/progress.js';
import type { Card } from './episodes';

const PLATFORM = { yt: 'YouTube', sp: 'Spotify' } as const;
const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * One line (Telegram HTML) for the copy `r` of an episode: finished and where, seen without a position,
 * how far and a link to continue on this platform at the right moment, or not played yet.
 */
export function mediaLine(c: Card | null | undefined, r: { p: 'yt' | 'sp'; id: string }): string {
  if (!c || c.status === 'new') return '🆕 Not played yet, on YouTube or Spotify.';
  if (c.status === 'finished') {
    const on = c.doneOn === 'yt' || c.doneOn === 'sp' ? ` on ${PLATFORM[c.doneOn]}` : '';
    const date = c.finishedAt ? new Date(c.finishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    return `✅ Already finished${on}${date ? ` (${c.finishedBefore ? `before ${date}` : date})` : ''}.`;
  }
  const res = c.resume;
  if (c.seen && !res && c.pct < 0.02) return `◐ Seen on ${PLATFORM[c.seen]}; it kept no position.`;
  if (!res) return `◐ ${Math.round(c.pct * 100)}% heard.`;
  const pos = res.p === r.p ? res.pos : mapPosition(res.pos, res.dur || c[res.p]?.dur || null, c[r.p]?.dur || null).pos;
  return `◐ ${Math.round(c.pct * 100)}% heard, stopped at ${clock(res.pos)} on ${PLATFORM[res.p]}. <a href="${esc(watchUrl(r.p, r.id, pos))}">Continue on ${PLATFORM[r.p]} at ${clock(pos)}</a>`;
}
