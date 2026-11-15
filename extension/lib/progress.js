// Watch and listen progress for videos and podcast episodes that can live on YouTube (yt) and
// Spotify (sp). Pure functions shared by the extension, the web app and the tests.
//
// For each platform copy of an episode Trove keeps:
//   ranges   the parts you actually played, in seconds ([[start, end], ...]). Seeking never adds
//            to them, so jumping to the end doesn't count as watched and rewinding loses nothing.
//   pos, at  where you were last and when (ms epoch).
//   ext      what the platform itself reports for your account: Spotify's resume point and played
//            flag, YouTube's "watched" bar. That's how plays on the phone get in.
// summarize() turns that into new / started / finished, how much you've heard across both
// platforms, and where to resume. Finishing is sticky: re-listening never un-finishes an episode,
// only marking it as not finished does.

export const PLATFORMS = ['yt', 'sp'];
export const PLATFORM_NAME = { yt: 'YouTube', sp: 'Spotify' };
export const MAX_RANGES = 120;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round1 = (x) => Math.round(x * 10) / 10;

// ---------- ranges ----------

/** Sort, clamp and merge ranges; gaps up to `gap` seconds are bridged. */
export function normRanges(ranges, { gap = 2, max = Infinity, round = true } = {}) {
  const list = [];
  for (const r of ranges || []) {
    if (!Array.isArray(r) || !isNum(r[0]) || !isNum(r[1])) continue;
    const a = Math.max(0, Math.min(r[0], r[1]));
    const b = Math.min(max, Math.max(r[0], r[1]));
    if (b > a) list.push([a, b]);
  }
  list.sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of list) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  // Too many fragments (lots of seeking): close the smallest gaps first.
  while (out.length > MAX_RANGES) {
    let k = 0;
    for (let i = 1; i < out.length - 1; i++) if (out[i + 1][0] - out[i][1] < out[k + 1][0] - out[k][1]) k = i;
    out[k][1] = out[k + 1][1];
    out.splice(k + 1, 1);
  }
  return round ? out.map(([a, b]) => [round1(a), round1(b)]) : out;
}

export const addRange = (ranges, a, b) => normRanges([...(ranges || []), [a, b]]);

/** Seconds covered by the ranges (within the duration, when known). */
export function coveredSeconds(ranges, dur) {
  let s = 0;
  for (const [a, b] of ranges || []) {
    const hi = dur ? Math.min(b, dur) : b;
    if (hi > a) s += hi - a;
  }
  return s;
}

// ---------- tracking playback ----------

/**
 * Turns player samples into the ranges you actually played. Feed it {t, wall, rate, playing,
 * seeking} every second or so (t = media time in seconds, wall = Date.now()). Time only counts when
 * the media clock advanced about as much as the wall clock (times the playback rate); a jump starts
 * a new range, so seeks, ads (report playing:false) and stalls never inflate what you heard.
 */
export class Tracker {
  constructor({ tolerance = 1.6 } = {}) {
    this.tolerance = tolerance;
    this.ranges = [];
    this.run = null;
    this.last = null;
  }

  sample(s) {
    const prev = this.last;
    this.last = s;
    if (!s || !s.playing || s.seeking || !isNum(s.t)) return this.close();
    if (!prev || !prev.playing || prev.seeking || !isNum(prev.t)) {
      this.run = [s.t, s.t];
      return;
    }
    const media = s.t - prev.t;
    const rate = Math.max(prev.rate || 1, s.rate || 1);
    const expected = (Math.max(0, s.wall - prev.wall) / 1000) * rate;
    if (media >= -0.05 && media <= expected + this.tolerance) {
      if (!this.run) this.run = [prev.t, s.t];
      else this.run[1] = Math.max(this.run[1], s.t);
    } else {
      this.close();
      this.run = [s.t, s.t];
    }
  }

  close() {
    if (this.run && this.run[1] - this.run[0] >= 0.5) this.ranges = addRange(this.ranges, this.run[0], this.run[1]);
    this.run = null;
  }

  /** Everything played so far, including the range still growing. */
  snapshot() {
    return this.run && this.run[1] - this.run[0] >= 0.5 ? normRanges([...this.ranges, this.run]) : normRanges(this.ranges);
  }
}

// ---------- merging observations ----------

const pick = (newer, older, k) => (newer?.[k] !== undefined && newer?.[k] !== null && newer?.[k] !== '' ? newer[k] : older?.[k]);

/** What the platform reports for your account. Unchanged reports keep the time they were first seen. */
export function mergeExt(a, b) {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return { ...a };
  const [o, n] = (b.at || 0) >= (a.at || 0) ? [a, b] : [b, a];
  const same = Math.abs((n.pos || 0) - (o.pos || 0)) < 1 && !!n.done === !!o.done;
  if (same) return { ...o, dur: pick(n, o, 'dur'), src: n.src || o.src };
  const done = !!n.done;
  const doneAt = done ? (o.done && isNum(o.doneAt) ? o.doneAt : n.doneAt ?? n.at) : null;
  return { pos: n.pos ?? 0, dur: pick(n, o, 'dur'), done, doneAt, at: n.at, src: n.src || o.src };
}

/** Merge two observations of one platform copy. Order doesn't matter and merging twice changes nothing. */
export function mergePlatform(a, b) {
  if (!a && !b) return undefined;
  if (!a || !b) {
    const x = { ...(a || b) };
    if (x.ranges) x.ranges = normRanges(x.ranges);
    return x;
  }
  const [o, n] = (b.at || 0) >= (a.at || 0) ? [a, b] : [b, a];
  const out = {};
  for (const k of ['id', 'title', 'show', 'showId', 'channel', 'channelId', 'image', 'released']) {
    const v = pick(n, o, k);
    if (v !== undefined) out[k] = v;
  }
  // The longest length seen wins: a shorter one (an ad in the same player, a sample of the next
  // episode) must never shrink what was played. Ranges are only clipped when measuring.
  const durs = [a.dur, b.dur].filter((d) => isNum(d) && d > 0);
  if (durs.length) out.dur = Math.max(...durs);
  const ranges = normRanges([...(a.ranges || []), ...(b.ranges || [])]);
  if (ranges.length) out.ranges = ranges;
  const posSrc = isNum(n.at) && isNum(n.pos) ? n : isNum(o.pos) ? o : null;
  if (posSrc) {
    out.pos = posSrc.pos;
    out.at = posSrc.at;
  }
  const ext = mergeExt(a.ext, b.ext);
  if (ext) out.ext = ext;
  return out;
}

/** When a "not finished" mark was made (0 if none). */
export const resetTime = (rec) => (rec?.manual && rec.manual.done === false ? rec.manual.at || 0 : 0);

/** Merge two records of the same episode (e.g. two Notion pages that turned out to be one). */
export function mergeRecords(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { v: 1 };
  for (const k of ['title', 'show', 'image', 'released']) {
    const v = a[k] || b[k];
    if (v) out[k] = v;
  }
  const seriesFrom = a.seriesBy === 'manual' ? a : b.seriesBy === 'manual' ? b : a.series ? a : b;
  if (seriesFrom.series) {
    out.series = seriesFrom.series;
    if (seriesFrom.seriesBy) out.seriesBy = seriesFrom.seriesBy;
  }
  for (const p of PLATFORMS) {
    // Two different videos (or episodes) are never mixed: keep the first.
    const m = a[p]?.id && b[p]?.id && a[p].id !== b[p].id ? a[p] : mergePlatform(a[p], b[p]);
    if (m) out[p] = m;
  }
  const manual = [a.manual, b.manual].filter(Boolean).sort((x, y) => (y.at || 0) - (x.at || 0))[0];
  if (manual) out.manual = manual;
  const fin = [a.finishedAt, b.finishedAt].filter(isNum);
  if (fin.length) out.finishedAt = Math.min(...fin);
  const unlinked = [...new Set([...(a.unlinked || []), ...(b.unlinked || [])])];
  if (unlinked.length) out.unlinked = unlinked;
  if (a.linked || b.linked) out.linked = a.linked?.by === 'manual' ? a.linked : b.linked || a.linked;
  return out;
}

// ---------- events ----------

/**
 * An observation coming from a player or a sync:
 *   {p: 'yt'|'sp', id, at, title?, show?, showId?, channel?, channelId?, image?, released?, dur?,
 *    ranges?, pos?, ext?: {pos, done, dur?}, src}
 * Returns the updated record (a new object).
 */
export function applyEvent(rec, ev) {
  const base = rec ? { ...rec } : { v: 1 };
  const at = isNum(ev.at) ? ev.at : Date.now();
  const incoming = { id: ev.id };
  for (const k of ['title', 'show', 'showId', 'channel', 'channelId', 'image', 'released']) if (ev[k] !== undefined && ev[k] !== null && ev[k] !== '') incoming[k] = ev[k];
  if (isNum(ev.dur) && ev.dur > 0) incoming.dur = ev.dur;
  // A player keeps sending everything it played since it started (ev.since). After "Not finished",
  // what a session played before that mark doesn't count again.
  const reset = resetTime(base);
  if (ev.ranges?.length && !(reset && isNum(ev.since) && ev.since < reset)) incoming.ranges = ev.ranges;
  if (isNum(ev.pos)) {
    incoming.pos = Math.max(0, ev.pos);
    incoming.at = at;
  }
  if (ev.ext) incoming.ext = { pos: Math.max(0, ev.ext.pos || 0), dur: ev.ext.dur ?? ev.dur ?? undefined, done: !!ev.ext.done, doneAt: ev.ext.done ? at : null, at, src: ev.src || ev.p };
  base[ev.p] = mergePlatform(base[ev.p], incoming);
  if (!base.title && ev.title) base.title = ev.title;
  if (!base.show && (ev.show || ev.channel)) base.show = ev.show || ev.channel;
  if (!base.image && ev.image) base.image = ev.image;
  if (!base.released && ev.released) base.released = ev.released;
  return settle(base, at);
}

/** Record the moment an episode first counts as finished (finishing is sticky). */
export function settle(rec, at = Date.now()) {
  const s = summarize(rec);
  if (s.finished && !(rec.finishedAt > resetTime(rec))) rec.finishedAt = at;
  return rec;
}

/** Mark finished / not finished by hand. "Not finished" also forgets what was played. */
export function markManual(rec, done, at = Date.now()) {
  const out = { ...rec, manual: { done: !!done, at } };
  if (done) {
    if (!(out.finishedAt > resetTime(rec))) out.finishedAt = at;
  } else {
    delete out.finishedAt;
    for (const p of PLATFORMS) if (out[p]) out[p] = { ...out[p], ranges: [] };
  }
  return out;
}

// ---------- summary ----------

const FINISH_SHARE = 0.9; // of the episode actually played
const FINISH_WITH_END = 0.7; // ... or this much, including the ending

/** Whether one platform copy counts as finished on its own. */
function platformDone(x, resetAt) {
  const dur = x.dur || x.ext?.dur || 0;
  if (x.ext?.done && (x.ext.doneAt ?? x.ext.at ?? 0) > resetAt) return true;
  if (!dur) return false;
  const share = coveredSeconds(x.ranges, dur) / dur;
  const guard = Math.max(30, dur * 0.03);
  const reachedEnd = (x.ranges || []).some(([, b]) => b >= dur - guard);
  return share >= FINISH_SHARE || (share >= FINISH_WITH_END && reachedEnd);
}

/**
 * {status: 'new'|'started'|'finished', finished, pct (0..1 heard across platforms), finishedAt,
 *  doneOn: 'yt'|'sp'|'both'|'manual'|null, resume: {p, pos, dur, at, src}|null, last: {p, at}|null}
 */
export function summarize(rec) {
  if (!rec) return { status: 'new', finished: false, pct: 0, finishedAt: null, doneOn: null, resume: null, last: null };
  const resetAt = resetTime(rec);
  const fractions = [];
  let heard = 0;
  const doneOn = [];
  let last = null;
  const cands = [];
  for (const p of PLATFORMS) {
    const x = rec[p];
    if (!x) continue;
    const dur = x.dur || x.ext?.dur || 0;
    const extLive = x.ext && (x.ext.at || 0) > resetAt;
    if (dur) {
      for (const [a, b] of x.ranges || []) fractions.push([a / dur, Math.min(b, dur) / dur]);
      if (extLive && x.ext.pos > 0) fractions.push([0, Math.min(x.ext.pos, dur) / dur]);
    }
    heard = Math.max(heard, coveredSeconds(x.ranges, dur || undefined), extLive ? x.ext.pos || 0 : 0);
    if (platformDone(x, resetAt)) doneOn.push(p);
    if (isNum(x.at) && isNum(x.pos)) cands.push({ p, pos: x.pos, dur, at: x.at, src: 'trove' });
    if (extLive && isNum(x.ext.at)) cands.push({ p, pos: x.ext.pos || 0, dur, at: x.ext.at, src: x.ext.src || p, done: x.ext.done });
  }
  for (const c of cands) if (!last || c.at > last.at) last = { p: c.p, at: c.at };
  const union = Math.min(1, coveredSeconds(normRanges(fractions, { gap: 0.004, round: false }), 1));
  const manualDone = rec.manual?.done === true;
  const sticky = isNum(rec.finishedAt) && rec.finishedAt > resetAt;
  const finished = manualDone || sticky || doneOn.length > 0 || union >= 0.92;
  const pct = finished ? 1 : Math.round(union * 1000) / 1000;
  const started = finished || union >= 0.02 || heard >= 45;
  // Resume where you were last on any platform, unless that was the very end.
  let resume = null;
  const latest = cands.filter((c) => !c.done).sort((x, y) => y.at - x.at)[0];
  if (latest && latest.pos >= 15 && !(latest.dur && latest.pos >= latest.dur - 45)) resume = { p: latest.p, pos: Math.round(latest.pos), dur: latest.dur || null, at: latest.at, src: latest.src };
  let on = null;
  if (finished) {
    if (doneOn.length === 2 || (!doneOn.length && union >= 0.92)) on = 'both';
    else if (doneOn.length === 1) on = doneOn[0];
    else if (manualDone) on = 'manual';
    else on = last?.p || null;
  }
  return {
    status: finished ? 'finished' : started ? 'started' : 'new',
    finished,
    pct,
    finishedAt: finished ? (sticky ? rec.finishedAt : manualDone ? rec.manual.at : last?.at || null) : null,
    doneOn: on,
    resume,
    last,
  };
}

/** Where to start on another copy: same second when the lengths agree, proportional otherwise. */
export function mapPosition(pos, fromDur, toDur) {
  if (!isNum(pos)) return { pos: 0, exact: false };
  if (!fromDur || !toDur) return { pos, exact: false };
  const diff = Math.abs(fromDur - toDur);
  if (diff <= Math.max(20, 0.015 * Math.max(fromDur, toDur))) return { pos: Math.min(pos, toDur), exact: true };
  return { pos: Math.round((pos / fromDur) * toDur), exact: false };
}

// ---------- formatting & ids ----------

/** 3723 -> "1:02:03", 95 -> "1:35" */
export function clock(sec) {
  if (!isNum(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** "1:02:03" / "44:14" -> seconds */
export function parseClock(text) {
  const m = /(\d+(?::\d{1,2}){1,2})/.exec(String(text || ''));
  if (!m) return null;
  return m[1].split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
}

/** "1 hr 2 min", "44 min 14 sec", "2 h 5 min", "3 min left" -> seconds */
export function parseHumanDuration(text) {
  const s = String(text || '').toLowerCase();
  let total = 0;
  let hit = false;
  for (const [, n, unit] of s.matchAll(/(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g)) {
    const v = Number(n.replace(',', '.'));
    total += unit.startsWith('h') ? v * 3600 : unit.startsWith('m') ? v * 60 : v;
    hit = true;
  }
  return hit ? Math.round(total) : parseClock(s);
}

export const youtubeId = (url) =>
  /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/|youtube-nocookie\.com\/embed\/)([\w-]{11})/.exec(url || '')?.[1] || (/^[\w-]{11}$/.test(url || '') ? url : null);
export const spotifyEpisodeId = (url) => /(?:open\.spotify\.com\/(?:intl-[\w-]+\/)?(?:embed\/)?episode\/|spotify:episode:)([A-Za-z0-9]{22})/.exec(url || '')?.[1] || null;
export const spotifyShowId = (url) => /(?:open\.spotify\.com\/(?:intl-[\w-]+\/)?(?:embed\/)?show\/|spotify:show:)([A-Za-z0-9]{22})/.exec(url || '')?.[1] || null;

/** {p, id} for a YouTube video or Spotify episode URL. */
export function mediaRef(url) {
  const yt = /youtu\.?be|youtube/.test(url || '') ? youtubeId(url) : null;
  if (yt) return { p: 'yt', id: yt };
  const sp = spotifyEpisodeId(url);
  return sp ? { p: 'sp', id: sp } : null;
}

/** Start time from a link (?t=1h2m3s, ?t=95, #t=1:35). */
export function startTimeOf(url) {
  const m = /[?&#](?:t|start|time_continue)=([\dhms:.]+)/i.exec(url || '');
  if (!m) return null;
  const v = m[1];
  if (/^\d+(\.\d+)?$/.test(v)) return Math.floor(Number(v));
  return parseHumanDuration(v.replace(/(\d)([hms])/g, '$1 $2 '));
}

export const watchUrl = (p, id, pos) =>
  p === 'yt'
    ? `https://www.youtube.com/watch?v=${id}${pos >= 5 ? `&t=${Math.floor(pos)}s` : ''}`
    : `https://open.spotify.com/episode/${id}${pos >= 5 ? `?t=${Math.floor(pos)}` : ''}`;

// ---------- matching the same episode across platforms ----------

const FILLER = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'is', 'its', 'it', 'this', 'that', 'ep', 'episode', 'podcast', 'full', 'official', 'video', 'audio', 'feat', 'ft', 'w', 'vs', 'el', 'la', 'los', 'las', 'de', 'del', 'y', 'en', 'con', 'un', 'una']);

export function titleTokens(title, stop) {
  const s = String(title || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  return s.split(' ').filter((w) => w && !FILLER.has(w) && !(stop && stop.has(w)));
}

/** Words that appear in most titles of a show (its name, the series names) and say nothing about one episode. */
export function commonWords(titles, share = 0.3) {
  const counts = new Map();
  for (const t of titles) for (const w of new Set(titleTokens(t))) counts.set(w, (counts.get(w) || 0) + 1);
  const min = Math.max(3, titles.length * share);
  return new Set([...counts].filter(([, n]) => n >= min).map(([w]) => w));
}

export function titleSimilarity(a, b, stop) {
  const A = new Set(titleTokens(a, stop));
  const B = new Set(titleTokens(b, stop));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const dice = (2 * inter) / (A.size + B.size);
  const small = Math.min(A.size, B.size);
  const contain = (inter / small) * (small >= 3 ? 0.92 : 0.7);
  let s = Math.max(dice, contain);
  // Episode numbers must agree when both titles have them.
  const nums = (S) => [...S].filter((w) => /^\d+$/.test(w) && w.length < 5);
  const na = nums(A);
  const nb = nums(B);
  if (na.length && nb.length && !na.some((n) => nb.includes(n))) s *= 0.5;
  return Math.round(s * 1000) / 1000;
}

export function durationScore(a, b) {
  if (!a || !b) return null;
  const diff = Math.abs(a - b);
  const rel = diff / Math.max(a, b);
  if (diff <= 25 || rel <= 0.012) return 1;
  if (rel <= 0.03) return 0.9;
  if (rel <= 0.06) return 0.7;
  if (rel <= 0.12) return 0.4;
  if (rel <= 0.25) return 0.15;
  return 0;
}

export function dateScore(a, b) {
  if (!a || !b) return null;
  const days = Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
  if (!Number.isFinite(days)) return null;
  if (days <= 1.5) return 1;
  if (days <= 4) return 0.8;
  if (days <= 10) return 0.5;
  if (days <= 31) return 0.25;
  return 0;
}

/** How likely two items {title, dur, date} are the same episode. */
export function matchScore(a, b, stop) {
  const t = titleSimilarity(a.title, b.title, stop);
  const d = durationScore(a.dur, b.dur);
  const r = dateScore(a.date, b.date);
  let w = 0.55;
  let s = 0.55 * t;
  if (d !== null) {
    s += 0.3 * d;
    w += 0.3;
  }
  if (r !== null) {
    s += 0.15 * r;
    w += 0.15;
  }
  return { score: Math.round((s / w) * 1000) / 1000, t, d, r };
}

/** Strict enough to link automatically. */
export function confident(m) {
  if (m.d !== null && m.d < 0.4) return false; // very different lengths: different content
  if (m.t >= 0.85) return true;
  if (m.t >= 0.6 && m.d !== null && m.d >= 0.8) return true;
  if (m.t >= 0.3 && m.d !== null && m.d >= 0.9 && m.r !== null && m.r >= 0.8) return true;
  return false;
}

/**
 * Pair items of two lists (e.g. a show's Spotify episodes and YouTube videos), best pairs first,
 * each item used once; ambiguous ties are left unpaired. Items: {id, title, dur?, date?}.
 * `skip(a, b)` excludes pairs (ones you said are not the same episode) before choosing.
 */
export function matchAll(A, B, { stop, skip } = {}) {
  const cands = [];
  for (const a of A) {
    for (const b of B) {
      if (skip?.(a, b)) continue;
      const m = matchScore(a, b, stop);
      if (confident(m)) cands.push({ a, b, ...m });
    }
  }
  cands.sort((x, y) => y.score - x.score);
  const usedA = new Set();
  const usedB = new Set();
  const out = [];
  for (const c of cands) {
    if (usedA.has(c.a.id) || usedB.has(c.b.id)) continue;
    const rival = cands.find((o) => o !== c && c.score - o.score < 0.03 && ((o.a.id === c.a.id && !usedB.has(o.b.id)) || (o.b.id === c.b.id && !usedA.has(o.a.id))));
    if (rival) continue;
    usedA.add(c.a.id);
    usedB.add(c.b.id);
    out.push(c);
  }
  return out;
}

/** Best confident match for one item, or null when nothing (or more than one thing) fits. */
export function bestMatch(item, candidates, { stop } = {}) {
  const scored = candidates.map((c) => ({ c, ...matchScore(item, c, stop) })).filter(confident).sort((x, y) => y.score - x.score);
  if (!scored.length) return null;
  if (scored[1] && scored[0].score - scored[1].score < 0.03) return null;
  return scored[0];
}

// ---------- series ----------

/** First rule that matches the title: [{series, pattern}] with plain text (case-insensitive) or /regex/. */
export function seriesFor(title, rules) {
  for (const r of rules || []) {
    if (!r?.pattern || !r.series) continue;
    try {
      const m = /^\/(.+)\/([a-z]*)$/.exec(r.pattern);
      const re = m ? new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i') : null;
      if (re ? re.test(title) : String(title).toLowerCase().includes(r.pattern.toLowerCase())) return r.series;
    } catch { /* bad regex: skip */ }
  }
  return null;
}

/** Prefixes like "How To Build The Future: …" or suffixes like "… | Lightcone" shared by several titles. */
export function suggestSeries(titles, min = 3) {
  const counts = new Map();
  const add = (k) => {
    const key = k.trim();
    if (key.length >= 3 && key.length <= 48 && key.split(/\s+/).length <= 6) counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (const t of titles) {
    const pre = /^([^:|–—]{3,48})\s*[:|–—]\s+\S/.exec(t)?.[1];
    if (pre) add(pre);
    const post = /\S\s+[|–—]\s*([^|–—]{3,48})$/.exec(t)?.[1];
    if (post) add(post);
    const paren = /\(([^()]{3,48})\)\s*$/.exec(t)?.[1];
    if (paren && !/\d{4}|full|episode|ep\.?\s*\d/i.test(paren)) add(paren);
  }
  return [...counts].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}
