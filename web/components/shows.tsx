'use client';
import { Check, CirclePlay, Ellipsis, Headphones, Link2, Plus, RefreshCw, Search, Settings2, Trash2, Unlink, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { Tracker, clock, coveredSeconds, mapPosition } from '../../extension/lib/progress.js';
import { api, fmtDate, timeAgo } from './api';
import { Dialog, useMenu, useToast, type MenuItem } from './ui';

type P = 'yt' | 'sp';
type Copy = { id: string; dur: number | null; title: string | null };
export type MediaCard = {
  id: string;
  title: string;
  show: string | null;
  series: string | null;
  image: string | null;
  released: string | null;
  yt: Copy | null;
  sp: Copy | null;
  status: 'new' | 'started' | 'finished';
  pct: number;
  finishedAt: number | null;
  finishedBefore?: boolean;
  doneOn: string | null;
  resume: { p: P; pos: number; dur: number | null; at: number; src: string; before?: boolean } | null;
  last: { p: P; at: number; before?: boolean } | null;
  seen?: P | null;
  updated: string;
  notionUrl: string;
};
type ShowPlaylist = { id: string; title: string; series: string | null };
type Show = {
  id: string;
  title: string;
  image: string | null;
  spotify: { id: string; title: string } | null;
  youtube: { channelId: string | null; title: string; playlists: ShowPlaylist[]; uploads: boolean } | null;
  rules: { series: string; pattern: string }[];
  catalog?: { at: number; episodes: number; error: string | null } | null;
};
type Row = {
  key: string;
  title: string;
  date: string | null;
  dur: number | null;
  series: string | null;
  image: string | null;
  sp: { id: string; dur: number | null; title: string } | null;
  yt: { id: string; dur: number | null; title: string } | null;
  pairedBy?: string;
  card: MediaCard | null;
};
type ShowData = { show: Show; catalog: { at: number; error: string | null; spotify: number; youtube: number; paired: number } | null; series: { name: string; count: number; finished: number; started: number }[]; episodes: Row[] };
type Side = { connected: boolean; at: number | null; ok: boolean | null; error: string | null; needsSignIn: boolean; user?: string | null };
type SyncStatus = { spotify: Side; youtube: Side; shows: number };

const NAME: Record<P, string> = { yt: 'YouTube', sp: 'Spotify' };
const fetcher = (u: string) => api(u);
const linkTo = (p: P, id: string, pos = 0) =>
  p === 'yt' ? `https://www.youtube.com/watch?v=${id}${pos >= 5 ? `&t=${Math.floor(pos)}s` : ''}` : `https://open.spotify.com/episode/${id}${pos >= 5 ? `?t=${Math.floor(pos)}` : ''}`;
const minutes = (s: number | null | undefined) => (!s ? '' : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`);

/** Where to pick up on platform p: your last position, mapped from the other platform when needed. */
function resumeOn(card: MediaCard | null, p: P, dur: number | null): { pos: number; exact: boolean } {
  const r = card?.status === 'started' ? card.resume : null;
  if (!r) return { pos: 0, exact: true };
  if (r.p === p) return { pos: r.pos, exact: true };
  return mapPosition(r.pos, r.dur || card?.[r.p]?.dur || null, dur);
}

/** "3 h ago", or "before 15 Nov" when Trove only knows it had happened by then (found already played). */
const whenText = (at: number, before?: boolean) => (before ? `before ${fmtDate(new Date(at).toISOString())}` : timeAgo(new Date(at).toISOString()));

function statusLine(card: MediaCard | null) {
  if (!card || card.status === 'new') return '';
  if (card.status === 'finished') {
    const on = card.doneOn && card.doneOn !== 'both' && card.doneOn !== 'manual' ? ` on ${NAME[card.doneOn as P]}` : '';
    return `Finished${on}${card.finishedAt ? ` · ${whenText(card.finishedAt, card.finishedBefore)}` : ''}`;
  }
  const r = card.resume;
  // Seen on a platform that kept no position (YouTube's history does that for some videos).
  if (card.seen && !r && card.pct < 0.02) return `Seen on ${NAME[card.seen]}${card.last ? ` · ${whenText(card.last.at, card.last.before)}` : ''}`;
  return `${Math.round(card.pct * 100)}%${r ? ` · at ${clock(r.pos)}${r.dur ? ` of ${clock(r.dur)}` : ''} on ${NAME[r.p]} · ${whenText(r.at, r.before)}` : ''}`;
}

export function PlatformLogo({ p, size = 14 }: { p: P; size?: number }) {
  return p === 'yt' ? (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1.5" y="4.5" width="21" height="15" rx="4.5" fill="#ff0033" />
      <path d="M10 8.6v6.8l5.6-3.4z" fill="#fff" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#1ed760" />
      <path d="M6.6 9.4c3.7-1.1 7.9-.8 11 1M7.3 12.6c3-.8 6.4-.5 8.9.9M8 15.6c2.3-.6 4.9-.4 6.8.7" stroke="#000" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function Ring({ card }: { card: MediaCard | null }) {
  const st = card?.status || 'new';
  if (st === 'finished')
    return (
      <span className="ep-ring done" title="Finished" aria-label="Finished">
        <Check size={13} strokeWidth={3} />
      </span>
    );
  const pct = st === 'started' ? Math.max(0.04, card!.pct) : 0;
  const c = 2 * Math.PI * 8;
  return (
    <span className={`ep-ring ${st}`} title={st === 'started' ? `${Math.round(pct * 100)}% heard` : 'Not started'} aria-label={st === 'started' ? `${Math.round(pct * 100)}% heard` : 'Not started'}>
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8" className="track" />
        {pct > 0 && <circle cx="10" cy="10" r="8" className="arc" strokeDasharray={`${c * pct} ${c}`} transform="rotate(-90 10 10)" />}
      </svg>
    </span>
  );
}

// ---------- players inside Trove ----------

type PlayItem = { p: P; id: string; title: string; start: number; twin: { p: P; id: string } | null; show?: string | null };

let ytApi: Promise<any> | null = null;
function loadYouTube(): Promise<any> {
  ytApi ||= new Promise((resolve) => {
    const w = window as any;
    if (w.YT?.Player) return resolve(w.YT);
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(w.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.append(s);
  });
  return ytApi;
}

let spApi: Promise<any> | null = null;
function loadSpotify(): Promise<any> {
  spApi ||= new Promise((resolve) => {
    (window as any).onSpotifyIframeApiReady = (IFrameAPI: any) => resolve(IFrameAPI);
    const s = document.createElement('script');
    s.src = 'https://open.spotify.com/embed/iframe-api/v1';
    s.async = true;
    document.head.append(s);
  });
  return spApi;
}

/** A YouTube or Spotify player docked at the bottom; what you play here is tracked like anywhere else. */
function Player({ item, onClose, onCards }: { item: PlayItem; onClose: () => void; onCards: (cards: MediaCard[]) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const el = document.createElement('div');
    host.current?.replaceChildren(el);
    const tracker = new Tracker();
    const since = Date.now();
    let dur: number | null = null;
    let pos = 0;
    let lastSend = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    let yt: any = null;
    let sp: any = null;
    let sought = false;
    const send = () => {
      const ranges = tracker.snapshot();
      if (coveredSeconds(ranges) < 3) return;
      lastSend = Date.now();
      api<{ cards: MediaCard[] }>('/api/media/events', { method: 'POST', json: { events: [{ p: item.p, id: item.id, at: Date.now(), since, pos, dur, ranges, title: item.title, show: item.show || undefined, src: 'trove', twin: item.twin }] } })
        .then((r) => onCards(r.cards))
        .catch(() => {});
    };
    const sample = (s: { t: number; dur: number | null; playing: boolean; rate?: number }) => {
      tracker.sample({ t: s.t, wall: Date.now(), rate: s.rate || 1, playing: s.playing });
      if (!s.playing) return;
      if (s.dur && (!dur || s.dur > dur * 0.5)) dur = s.dur;
      pos = s.t;
      if (Date.now() - lastSend > 15000) send();
    };
    if (item.p === 'yt') {
      loadYouTube().then((YT) => {
        yt = new YT.Player(el, {
          videoId: item.id,
          width: '100%',
          height: '100%',
          playerVars: { start: Math.floor(item.start || 0), autoplay: 1, playsinline: 1, rel: 0 },
          events: {
            onStateChange: (e: any) => {
              if (e.data === 2 || e.data === 0) {
                poll();
                send();
              }
            },
            onError: () => setError('YouTube won’t play this video here'),
          },
        });
        const poll = () => {
          if (!yt?.getCurrentTime) return;
          sample({ t: yt.getCurrentTime(), dur: yt.getDuration() || null, playing: yt.getPlayerState?.() === 1, rate: yt.getPlaybackRate?.() || 1 });
        };
        timer = setInterval(poll, 1000);
      });
    } else {
      loadSpotify().then((IFrameAPI) => {
        IFrameAPI.createController(el, { uri: `spotify:episode:${item.id}`, width: '100%', height: 152 }, (c: any) => {
          sp = c;
          c.addListener('ready', () => c.play());
          c.addListener('playback_update', (e: any) => {
            const d = e.data || {};
            const playing = !d.isPaused && !d.isBuffering;
            if (playing && !sought && item.start > 5 && d.position < 5000) {
              sought = true;
              c.seek(Math.floor(item.start));
              return;
            }
            sample({ t: (d.position || 0) / 1000, dur: d.duration ? d.duration / 1000 : null, playing });
            if (d.isPaused) send();
          });
        });
      });
    }
    const onHide = () => document.hidden && send();
    const onLeave = () => send();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onLeave);
    return () => {
      tracker.close();
      send();
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onLeave);
      try {
        yt?.destroy?.();
        sp?.destroy?.();
      } catch { /* already gone */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.p, item.id]);
  return (
    <div className={`player-dock ${item.p}`} role="region" aria-label={`Playing ${item.title}`}>
      <div className="player-head">
        <PlatformLogo p={item.p} />
        <span className="t">{item.title}</span>
        <a className="btn ghost sm" href={linkTo(item.p, item.id, item.start)} target="_blank" rel="noreferrer">Open in {NAME[item.p]}</a>
        <button className="icon-btn sm" onClick={onClose} aria-label="Close player">
          <X size={16} />
        </button>
      </div>
      {error && <p className="muted">{error}</p>}
      <div className="player-frame" ref={host} />
    </div>
  );
}

// ---------- rows ----------

type Act = {
  onPlay: (it: PlayItem) => void;
  onChanged: (cards?: MediaCard[]) => void;
  show?: Show;
};

/** One episode: status, progress, and buttons to continue on either platform. */
function EpisodeRow({ row, act, dense }: { row: Row; act: Act; dense?: boolean }) {
  const menu = useMenu();
  const toast = useToast();
  const [linking, setLinking] = useState<P | null>(null);
  const card = row.card;
  // Each platform's own length only: borrowing the other's would make a mapped time look exact.
  const ytRes = row.yt ? resumeOn(card, 'yt', row.yt.dur || card?.yt?.dur || null) : null;
  const spRes = row.sp ? resumeOn(card, 'sp', row.sp.dur || card?.sp?.dur || null) : null;
  const preferred: P = card?.resume?.p && row[card.resume.p] ? card.resume.p : row.sp ? 'sp' : 'yt';

  /** Episodes you never played have no page yet: create one first. */
  const ensure = async (extra: Record<string, unknown> = {}): Promise<MediaCard | null> => {
    if (card) return card;
    const p: P = row.sp ? 'sp' : 'yt';
    const other: P = p === 'sp' ? 'yt' : 'sp';
    const r = await api<{ cards: MediaCard[] }>('/api/media/events', {
      method: 'POST',
      json: { events: [{ p, id: row[p]!.id, at: Date.now(), title: row.title, show: act.show?.title, dur: row[p]!.dur || row.dur || undefined, released: row.date || undefined, src: 'manual', twin: row[other] ? { p: other, id: row[other]!.id, by: row.pairedBy || 'catalog' } : undefined, ...extra }] },
    });
    return r.cards[0] || null;
  };

  const patch = async (body: Record<string, unknown>, done: string) => {
    try {
      const c = await ensure();
      if (!c) return;
      const r = await api<{ card: MediaCard; split?: MediaCard }>(`/api/media/episodes/${c.id}`, { method: 'PATCH', json: body });
      act.onChanged([r.card, ...(r.split ? [r.split] : [])]);
      toast.push({ text: done });
    } catch (e: any) {
      toast.push({ text: `Couldn’t update: ${e.message}` });
    }
  };

  const items: MenuItem[] = [
    card?.status === 'finished'
      ? { label: 'Mark as not finished', icon: <Undo />, run: () => patch({ status: 'unfinished' }, 'Marked as not finished') }
      : { label: 'Mark as finished', icon: <Check size={15} />, run: () => patch({ status: 'finished' }, 'Marked as finished') },
    'sep',
    ...(!row.yt ? [{ label: 'Link the YouTube video…', icon: <Link2 size={15} />, run: () => setLinking('yt') }] : []),
    ...(!row.sp ? [{ label: 'Link the Spotify episode…', icon: <Link2 size={15} />, run: () => setLinking('sp') }] : []),
    ...(row.yt && row.sp
      ? [{
          label: 'Not the same episode (unlink)',
          icon: <Unlink size={15} />,
          run: async () => {
            if (act.show) await api(`/api/media/shows/${act.show.id}`, { method: 'PATCH', json: { unlink: { sp: row.sp!.id, yt: row.yt!.id } } }).catch(() => {});
            if (card) await patch({ unlink: 'yt' }, 'Unlinked');
            else act.onChanged();
          },
        }]
      : []),
    ...(card?.notionUrl ? ['sep' as const, { label: 'Open in Notion', run: () => window.open(card.notionUrl, '_blank') }] : []),
  ];

  const playHere = () => {
    const p = preferred;
    const res = p === 'yt' ? ytRes : spRes;
    const other: P = p === 'yt' ? 'sp' : 'yt';
    act.onPlay({ p, id: row[p]!.id, title: row.title, start: res?.pos || 0, twin: row[other] ? { p: other, id: row[other]!.id } : null, show: act.show?.title || card?.show });
  };

  const status = statusLine(card);
  return (
    <div className={`ep-row ${dense ? 'dense' : ''} ${card?.status || 'new'}`}>
      <Ring card={card} />
      {!dense && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="ep-thumb" src={row.image || (row.yt ? `https://i.ytimg.com/vi/${row.yt.id}/mqdefault.jpg` : '')} alt="" loading="lazy" onError={(e) => ((e.target as HTMLElement).style.visibility = 'hidden')} />
      )}
      <div className="ep-main">
        <div className="ep-title" title={row.title}>{row.title}</div>
        <div className="ep-meta">
          {!dense && card?.show && <span>{card.show}</span>}
          {row.series && <span className="ep-series">{row.series}</span>}
          {row.date && <span>{fmtDate(row.date)}</span>}
          {row.dur && <span>{minutes(row.dur)}</span>}
          {status && <span className={`ep-status ${card?.status}`}>{status}</span>}
        </div>
        {card?.status === 'started' && (
          <div className="ep-progress" aria-hidden="true">
            <i style={{ width: `${Math.round(card.pct * 100)}%` }} />
          </div>
        )}
      </div>
      <div className="ep-actions">
        {row.sp && (
          <a className={`plat ${preferred === 'sp' && card?.status === 'started' ? 'resume' : ''}`} href={linkTo('sp', row.sp.id, spRes?.pos)} target="_blank" rel="noreferrer" title={spRes?.pos ? `Continue on Spotify at ${clock(spRes.pos)}` : 'Open on Spotify'}>
            <PlatformLogo p="sp" />
            {spRes && spRes.pos >= 5 ? <span className="num">{spRes.exact ? '' : '≈'}{clock(spRes.pos)}</span> : <span className="sr-only">Spotify</span>}
          </a>
        )}
        {row.yt && (
          <a className={`plat ${preferred === 'yt' && card?.status === 'started' ? 'resume' : ''}`} href={linkTo('yt', row.yt.id, ytRes?.pos)} target="_blank" rel="noreferrer" title={ytRes?.pos ? `Continue on YouTube at ${clock(ytRes.pos)}` : 'Open on YouTube'}>
            <PlatformLogo p="yt" />
            {ytRes && ytRes.pos >= 5 ? <span className="num">{ytRes.exact ? '' : '≈'}{clock(ytRes.pos)}</span> : <span className="sr-only">YouTube</span>}
          </a>
        )}
        <button className="icon-btn sm" onClick={playHere} aria-label="Play here" title="Play here">
          <CirclePlay size={17} />
        </button>
        <button className="icon-btn sm" onClick={(e) => menu.open(e, items, 'right')} aria-label="More">
          <Ellipsis size={17} />
        </button>
      </div>
      {menu.node}
      {linking && (
        <LinkDialog
          want={linking}
          onClose={() => setLinking(null)}
          onLink={async (url) => {
            const id = linking === 'yt' ? /(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/.exec(url)?.[1] : /episode\/([A-Za-z0-9]{22})/.exec(url)?.[1];
            if (!id) throw new Error(`That isn’t a ${NAME[linking]} ${linking === 'yt' ? 'video' : 'episode'} link`);
            if (act.show && (row.sp || linking === 'sp') && (row.yt || linking === 'yt')) {
              await api(`/api/media/shows/${act.show.id}`, { method: 'PATCH', json: { link: { sp: linking === 'sp' ? id : row.sp!.id, yt: linking === 'yt' ? id : row.yt!.id } } }).catch(() => {});
            }
            await patch({ link: `${linking}:${id}` }, 'Linked');
            setLinking(null);
          }}
        />
      )}
    </div>
  );
}

const Undo = () => <RefreshCw size={15} />;

function LinkDialog({ want, onClose, onLink }: { want: P; onClose: () => void; onLink: (url: string) => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog onClose={onClose} label={`Link the ${NAME[want]} copy`}>
      <div className="dialog-head">
        <h3>Same episode on {NAME[want]}</h3>
        <p>Paste the {want === 'yt' ? 'YouTube video' : 'Spotify episode'} link. Progress on either counts for both from now on.</p>
      </div>
      <div className="dialog-body">
        <input className="input" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder={want === 'yt' ? 'https://www.youtube.com/watch?v=…' : 'https://open.spotify.com/episode/…'} aria-label="Link" />
        {err && <p className="field-hint" style={{ color: 'var(--danger)' }}>{err}</p>}
      </div>
      <div className="dialog-foot">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!url.trim() || busy}
          onClick={async () => {
            setBusy(true);
            setErr('');
            try {
              await onLink(url.trim());
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <span className="spinner" /> : <Link2 size={15} />} Link
        </button>
      </div>
    </Dialog>
  );
}

const cardRow = (c: MediaCard): Row => ({
  key: c.id,
  title: c.title,
  date: c.released,
  dur: c.sp?.dur || c.yt?.dur || null,
  series: c.series,
  image: c.image,
  sp: c.sp && { id: c.sp.id, dur: c.sp.dur, title: c.sp.title || c.title },
  yt: c.yt && { id: c.yt.id, dur: c.yt.dur, title: c.yt.title || c.title },
  card: c,
});

// ---------- the view ----------

export function ShowsView() {
  const toast = useToast();
  const [tab, setTab] = useState<string>('continue');
  const list = useSWR<{ shows: Show[]; continue: MediaCard[]; finished: MediaCard[] }>('/api/media/shows', fetcher, { revalidateOnFocus: true, dedupingInterval: 10000 });
  const status = useSWR<SyncStatus>('/api/media/connect', fetcher, { revalidateOnFocus: false });
  const [playing, setPlaying] = useState<PlayItem | null>(null);
  const [follow, setFollow] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const autoSynced = useRef(false);

  useEffect(() => {
    try {
      const t = new URLSearchParams(location.search).get('show') || localStorage.getItem('trove-show-tab');
      if (t) setTab(t);
    } catch { /* private mode */ }
  }, []);
  const pick = (t: string) => {
    setTab(t);
    try {
      localStorage.setItem('trove-show-tab', t);
    } catch { /* private mode */ }
  };

  const refresh = useCallback(() => {
    list.mutate();
    status.mutate();
  }, [list, status]);

  // Opening Shows (e.g. on the phone right after listening) pulls your Spotify / YouTube progress.
  useEffect(() => {
    const s = status.data;
    if (!s || autoSynced.current) return;
    const last = Math.max(s.spotify.at || 0, s.youtube.at || 0);
    if ((s.spotify.connected || s.youtube.connected) && Date.now() - last > 10 * 60e3) {
      autoSynced.current = true;
      api('/api/media/sync', { method: 'POST' })
        .then(() => setTimeout(refresh, 25000))
        .catch(() => {});
    }
  }, [status.data, refresh]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await api<Record<string, any>>('/api/media/sync?wait=1', { method: 'POST' });
      const parts = [r.spotify && (r.spotify.error ? `Spotify: ${r.spotify.error}` : `Spotify ✓`), r.youtube && (r.youtube.error ? `YouTube: ${r.youtube.error}` : `YouTube ✓`)].filter(Boolean);
      toast.push({ text: parts.length ? `${parts.join(' · ')} · ${r.updated || 0} updated` : 'Connect Spotify and YouTube in Settings to sync your phone' });
    } catch (e: any) {
      toast.push({ text: `Sync failed: ${e.message}` });
    } finally {
      setSyncing(false);
      refresh();
    }
  };

  const onCards = useCallback(() => list.mutate(), [list]);
  const act: Act = { onPlay: setPlaying, onChanged: onCards };
  const shows = list.data?.shows || [];
  const s = status.data;
  const lastSync = s ? Math.max(s.spotify.at || 0, s.youtube.at || 0) : 0;
  const needs = s && (s.spotify.needsSignIn || s.youtube.needsSignIn);

  return (
    <div className="shows">
      <div className="feed-bar">
        <div className="feed-chips" role="tablist" aria-label="Shows">
          <button className={`chip-btn ${tab === 'continue' ? 'on' : ''}`} role="tab" aria-selected={tab === 'continue'} onClick={() => pick('continue')}>
            Continue
          </button>
          {shows.map((sh) => (
            <button key={sh.id} className={`chip-btn ${tab === sh.id ? 'on' : ''}`} role="tab" aria-selected={tab === sh.id} onClick={() => pick(sh.id)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {sh.image && <img src={sh.image} alt="" className="chip-img" />}
              {sh.title}
            </button>
          ))}
          <button className="chip-btn" onClick={() => setFollow(true)}>
            <Plus size={14} /> Follow a show
          </button>
        </div>
        <button className="icon-btn" onClick={syncNow} disabled={syncing} aria-label="Sync Spotify and YouTube now" title={lastSync ? `Synced ${timeAgo(new Date(lastSync).toISOString())} ago` : 'Sync now'}>
          {syncing ? <span className="spinner" /> : <RefreshCw size={16} />}
        </button>
        <a className="icon-btn" href="/settings#shows" aria-label="Sync settings" title="Spotify & YouTube sync">
          <Settings2 size={16} />
        </a>
      </div>
      {needs && (
        <p className="shows-alert">
          {s!.spotify.needsSignIn ? 'Spotify' : 'YouTube'} needs a fresh sign-in for phone sync. <a href="/settings#shows">Reconnect</a>
        </p>
      )}

      {tab === 'continue' || !shows.some((x) => x.id === tab) ? (
        <ContinueTab data={list.data} loading={list.isLoading} act={act} onFollow={() => setFollow(true)} connected={!!(s?.spotify.connected || s?.youtube.connected)} />
      ) : (
        <ShowTab key={tab} id={tab} act={act} onGone={() => { pick('continue'); refresh(); }} />
      )}

      {follow && (
        <FollowDialog
          onClose={() => setFollow(false)}
          onDone={(id) => {
            setFollow(false);
            refresh();
            pick(id);
          }}
        />
      )}
      {playing && <Player item={playing} onClose={() => { setPlaying(null); list.mutate(); }} onCards={() => list.mutate()} />}
    </div>
  );
}

function ContinueTab({ data, loading, act, onFollow, connected }: { data?: { shows: Show[]; continue: MediaCard[]; finished: MediaCard[] }; loading: boolean; act: Act; onFollow: () => void; connected: boolean }) {
  if (loading && !data)
    return (
      <div style={{ display: 'grid', gap: 8 }} aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ height: 76, borderRadius: 10 }} />)}
      </div>
    );
  const cont = data?.continue || [];
  const fin = data?.finished || [];
  if (!cont.length && !fin.length)
    return (
      <div className="empty">
        <span className="empty-icon"><Headphones size={20} /></span>
        <h2>Never lose your place in a podcast</h2>
        <p>What you play on YouTube and Spotify shows up here with where you stopped, on whichever platform and device you were on. Play something with the Trove extension installed, or connect your Spotify and YouTube sign-ins so your phone counts too.</p>
        <div className="actions">
          <button className="btn primary" onClick={onFollow}><Plus size={15} /> Follow a show</button>
          {!connected && <a className="btn" href="/settings#shows">Connect phone sync</a>}
        </div>
      </div>
    );
  return (
    <div className="shows-sections">
      {cont.length > 0 && (
        <section>
          <h3 className="shows-h">Continue</h3>
          <div className="ep-list">
            {cont.map((c) => <EpisodeRow key={c.id} row={cardRow(c)} act={act} />)}
          </div>
        </section>
      )}
      {fin.length > 0 && (
        <section>
          <h3 className="shows-h">Recently finished</h3>
          <div className="ep-list">
            {fin.map((c) => <EpisodeRow key={c.id} row={cardRow(c)} act={act} dense />)}
          </div>
        </section>
      )}
    </div>
  );
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'new', label: 'Not started' },
  { id: 'started', label: 'In progress' },
  { id: 'finished', label: 'Finished' },
] as const;

function ShowTab({ id, act, onGone }: { id: string; act: Act; onGone: () => void }) {
  const toast = useToast();
  const menu = useMenu();
  const { data, error, isLoading, mutate } = useSWR<ShowData>(`/api/media/shows/${id}`, fetcher, { revalidateOnFocus: true });
  const [series, setSeries] = useState<string>('all');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const building = !!data && !data.catalog;

  // The catalog builds in the background after following: check back until it's there.
  useEffect(() => {
    if (!building) return;
    const t = setInterval(() => mutate(), 10000);
    return () => clearInterval(t);
  }, [building, mutate]);

  const rows = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.episodes || []).filter((r) => {
      if (series !== 'all' && (r.series || 'Other') !== series) return false;
      const st = r.card?.status || 'new';
      if (filter !== 'all' && st !== filter) return false;
      return !words.length || words.every((w) => r.title.toLowerCase().includes(w));
    });
  }, [data, series, filter, q]);

  if (error) return <p className="muted">Couldn’t load this show: {String(error.message || error)}</p>;
  if (isLoading || !data)
    return (
      <div style={{ display: 'grid', gap: 8 }} aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton" style={{ height: 56, borderRadius: 10 }} />)}
      </div>
    );

  const { show, catalog } = data;
  const total = data.episodes.length;
  const finished = data.episodes.filter((r) => r.card?.status === 'finished').length;
  const started = data.episodes.filter((r) => r.card?.status === 'started').length;
  const rowAct: Act = { ...act, show, onChanged: () => { mutate(); act.onChanged(); } };

  const rebuild = async () => {
    setBusy(true);
    try {
      const r = await api<{ spotify: number; youtube: number; paired: number; error: string | null }>(`/api/media/shows/${id}?action=refresh`, { method: 'POST' });
      toast.push({ text: r.error ? `Refreshed with problems: ${r.error}` : `${r.spotify} Spotify episodes · ${r.youtube} YouTube videos · ${r.paired} paired` });
      mutate();
    } catch (e: any) {
      toast.push({ text: `Refresh failed: ${e.message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="show">
      <div className="show-head">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {show.image && <img src={show.image} alt="" className="show-cover" />}
        <div className="show-info">
          <h2>{show.title}</h2>
          <p className="muted num">
            {building ? 'Building the episode list (both platforms, paired, series from the YouTube playlists)…' : `${total} episodes${catalog?.paired ? ` · ${catalog.paired} on both` : ''} · ${finished} finished · ${started} in progress`}
          </p>
          <p className="show-links">
            {show.spotify && <a href={`https://open.spotify.com/show/${show.spotify.id}`} target="_blank" rel="noreferrer"><PlatformLogo p="sp" /> {show.spotify.title}</a>}
            {show.youtube?.channelId && <a href={`https://www.youtube.com/channel/${show.youtube.channelId}`} target="_blank" rel="noreferrer"><PlatformLogo p="yt" /> {show.youtube.title}</a>}
            {catalog && <span className="muted">Updated {timeAgo(new Date(catalog.at).toISOString())}</span>}
            {catalog?.error && <span className="warn" title={catalog.error}>Some sources failed</span>}
          </p>
        </div>
        <div className="show-actions">
          <button className="btn" onClick={() => setEditing(true)} disabled={building}><Settings2 size={15} /> Series</button>
          <button className="icon-btn" onClick={rebuild} disabled={busy || building} aria-label="Refresh episodes" title="Refresh episodes">{busy ? <span className="spinner" /> : <RefreshCw size={16} />}</button>
          <button
            className="icon-btn"
            aria-label="More"
            onClick={(e) =>
              menu.open(e, [
                { label: 'Re-detect series from YouTube playlists', run: async () => { await api(`/api/media/shows/${id}?action=setup`, { method: 'POST' }); toast.push({ text: 'Re-reading the channel’s playlists…' }); setTimeout(() => mutate(), 20000); } },
                'sep',
                { label: 'Stop following', icon: <Trash2 size={15} />, danger: true, run: async () => { await api(`/api/media/shows/${id}`, { method: 'DELETE' }); onGone(); } },
              ], 'right')
            }
          >
            <Ellipsis size={16} />
          </button>
        </div>
      </div>

      {data.series.length > 1 && (
        <div className="feed-chips series-chips" role="tablist" aria-label="Series">
          <button className={`chip-btn ${series === 'all' ? 'on' : ''}`} role="tab" aria-selected={series === 'all'} onClick={() => setSeries('all')}>All <span className="num muted">{total}</span></button>
          {data.series.map((s) => (
            <button key={s.name} className={`chip-btn ${series === s.name ? 'on' : ''}`} role="tab" aria-selected={series === s.name} onClick={() => setSeries(s.name)} title={`${s.finished} finished · ${s.started} in progress`}>
              {s.name} <span className="num muted">{s.finished ? `${s.finished}/` : ''}{s.count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="show-filters">
        <div className="seg text" role="group" aria-label="Status">
          {FILTERS.map((f) => (
            <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
        </div>
        <label className="show-search">
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an episode" aria-label="Find an episode" />
        </label>
      </div>

      <div className="ep-list">
        {rows.map((r) => <EpisodeRow key={r.key} row={r} act={rowAct} dense />)}
        {!rows.length && <p className="muted" style={{ padding: '12px 4px' }}>{building ? 'Episodes appear here in a minute or two.' : 'No episodes match.'}</p>}
      </div>
      {menu.node}
      {editing && <SeriesDialog show={show} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); mutate(); }} />}
    </div>
  );
}

function FollowDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const [spotify, setSpotify] = useState('');
  const [youtube, setYouTube] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ show: Show }>('/api/media/shows', { method: 'POST', json: { spotify: spotify.trim() || undefined, youtube: youtube.trim() || undefined } });
      toast.push({ text: `Following ${r.show.title}. Its episodes are being paired across Spotify and YouTube…` });
      onDone(r.show.id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog onClose={onClose} label="Follow a show">
      <div className="dialog-head">
        <h3>Follow a show</h3>
        <p>Every episode in one list, the Spotify and YouTube copies paired, grouped into series (from the channel’s YouTube playlists), with what you’ve heard on either.</p>
      </div>
      <div className="dialog-body">
        <label className="field-label" htmlFor="f-sp">Spotify show</label>
        <input id="f-sp" className="input" autoFocus value={spotify} onChange={(e) => setSpotify(e.target.value)} placeholder="https://open.spotify.com/show/…" />
        <label className="field-label" htmlFor="f-yt" style={{ marginTop: 10 }}>YouTube channel or playlist <span className="muted">(optional, found from the Spotify show)</span></label>
        <input id="f-yt" className="input" value={youtube} onChange={(e) => setYouTube(e.target.value)} placeholder="@ycombinator, a channel or a playlist link" onKeyDown={(e) => e.key === 'Enter' && go()} />
        {err && <p className="field-hint" style={{ color: 'var(--danger)' }}>{err}</p>}
      </div>
      <div className="dialog-foot">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={go} disabled={busy || (!spotify.trim() && !youtube.trim())}>{busy ? <span className="spinner" /> : <Plus size={15} />} Follow</button>
      </div>
    </Dialog>
  );
}

function SeriesDialog({ show, onClose, onSaved }: { show: Show; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const lists = useSWR<{ playlists: { id: string; title: string; count: number | null; kind: string }[] }>(show.youtube?.channelId ? `/api/media/shows/${show.id}?playlists=1` : null, fetcher);
  const [chosen, setChosen] = useState<Record<string, string | null>>(() => Object.fromEntries((show.youtube?.playlists || []).map((p) => [p.id, p.series ?? p.title])));
  const [rules, setRules] = useState(show.rules.map((r) => `${r.series}: ${r.pattern}`).join('\n'));
  const [uploads, setUploads] = useState(show.youtube?.uploads ?? true);
  const [busy, setBusy] = useState(false);
  const all = useMemo(() => {
    const known = new Map((show.youtube?.playlists || []).map((p) => [p.id, { id: p.id, title: p.title, count: null as number | null }]));
    for (const p of lists.data?.playlists || []) known.set(p.id, { id: p.id, title: p.title, count: p.count });
    return [...known.values()];
  }, [lists.data, show.youtube]);
  const save = async () => {
    setBusy(true);
    try {
      const playlists = all.filter((p) => p.id in chosen).map((p) => ({ id: p.id, title: p.title, series: (chosen[p.id] || '').trim() || null }));
      const parsed = rules
        .split('\n')
        .map((l) => /^\s*([^:]+?)\s*:\s*(.+?)\s*$/.exec(l))
        .filter(Boolean)
        .map((m) => ({ series: m![1], pattern: m![2] }));
      await api(`/api/media/shows/${show.id}`, { method: 'PATCH', json: { playlists, rules: parsed, uploads } });
      // New playlists need their videos read.
      api(`/api/media/shows/${show.id}?action=refresh`, { method: 'POST' }).then(onSaved).catch(() => {});
      toast.push({ text: 'Saved. Re-reading the playlists…' });
      onSaved();
    } catch (e: any) {
      toast.push({ text: `Couldn’t save: ${e.message}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog onClose={onClose} label="Series" className="series-dialog">
      <div className="dialog-head">
        <h3>Series of {show.title}</h3>
        <p>An episode belongs to the series of the first YouTube playlist that has it, otherwise to the first title rule it matches, otherwise to Other. You can also move one episode by hand.</p>
      </div>
      <div className="dialog-body">
        {show.youtube?.channelId && (
          <>
            <div className="field-label">YouTube playlists as series</div>
            {lists.isLoading && <p className="muted">Reading the channel’s playlists…</p>}
            <div className="series-list">
              {all.map((p) => (
                <div key={p.id} className="series-pl">
                  <input type="checkbox" aria-label={`Use ${p.title}`} checked={p.id in chosen} onChange={(e) => setChosen((c) => {
                    const n = { ...c };
                    if (e.target.checked) n[p.id] = p.title.replace(/\s+(podcast|playlist)$/i, '');
                    else delete n[p.id];
                    return n;
                  })} />
                  <span className="t" title={p.title}>{p.title}{p.count ? <span className="muted num"> · {p.count}</span> : null}</span>
                  {p.id in chosen && <input className="input sm" value={chosen[p.id] || ''} onChange={(e) => setChosen((c) => ({ ...c, [p.id]: e.target.value }))} aria-label={`Series name for ${p.title}`} placeholder="Series name" />}
                </div>
              ))}
            </div>
            <label className="check-row" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={uploads} onChange={(e) => setUploads(e.target.checked)} />
              <span>Also look through the channel’s uploads to pair episodes that aren’t in a playlist</span>
            </label>
          </>
        )}
        <div className="field-label" style={{ marginTop: 12 }}>Title rules</div>
        <textarea className="input mono" rows={4} value={rules} onChange={(e) => setRules(e.target.value)} placeholder={'How To Build The Future: how to build the future\nLightcone: /\\|\\s*lightcone/'} spellCheck={false} />
        <p className="field-hint">One per line: <code>Series: text in the title</code> or <code>Series: /regex/</code>.</p>
      </div>
      <div className="dialog-foot">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? <span className="spinner" /> : <Check size={15} />} Save</button>
      </div>
    </Dialog>
  );
}
