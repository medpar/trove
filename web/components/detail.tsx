'use client';
import {
  ArrowUpRight, Bot, CalendarDays, CheckCircle2, Circle, Clock, Copy, ExternalLink, Folder, Hash, Headphones, Heart, Highlighter, Inbox, Landmark, Minus, NotebookPen, Pause, Play, Plus,
  RefreshCw, Sparkles, Square, Trash2, TriangleAlert, User, X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR, { mutate } from 'swr';
import { api, fmtDate, fmtDuration, patchItem, refreshAll, timeAgo, useItem } from './api';
import { highlightEntries, Reader } from './reader';
import { CollectionInput, TagInput } from './taginput';
import type { Item, Stats } from './types';
import { Favicon, TypeIcon, useToast } from './ui';

type Props = { id: string; seed?: Item; stats?: Stats; onClose: () => void; onDelete: (it: Item) => void; onAsk: (it: Item) => void; onOpen?: (id: string) => void };
type Tab = 'read' | 'archive' | 'highlights' | 'related';

const SIZES = [15, 16, 17, 18, 20, 22];

function useReaderSize() {
  const [size, setSize] = useState(17);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem('trove-reader-size'));
      if (SIZES.includes(v)) setSize(v);
    } catch { /* private mode */ }
  }, []);
  const change = (d: number) =>
    setSize((s) => {
      const next = SIZES[Math.max(0, Math.min(SIZES.length - 1, SIZES.indexOf(s) + d))] || 17;
      try {
        localStorage.setItem('trove-reader-size', String(next));
      } catch { /* private mode */ }
      return next;
    });
  return [size, change] as const;
}

/** Read the archived copy aloud with the browser's own voices. */
function useSpeech(getText: () => string) {
  const [state, setState] = useState<'idle' | 'playing' | 'paused'>('idle');
  const [rate, setRate] = useState(1);
  const [pos, setPos] = useState({ i: 0, n: 0 });
  const queue = useRef<string[]>([]);
  const rateRef = useRef(1);
  const idx = useRef(0);
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  const speakFrom = useCallback((i: number) => {
    const synth = window.speechSynthesis;
    synth.cancel();
    idx.current = i;
    const next = (k: number) => {
      if (k >= queue.current.length) {
        setState('idle');
        return;
      }
      idx.current = k;
      setPos({ i: k, n: queue.current.length });
      const u = new SpeechSynthesisUtterance(queue.current[k]);
      u.rate = rateRef.current;
      u.lang = document.documentElement.lang || navigator.language;
      u.onend = () => idx.current === k && next(k + 1);
      synth.speak(u);
    };
    next(i);
    setState('playing');
  }, []);

  const play = () => {
    if (!supported) return;
    if (state === 'paused') {
      window.speechSynthesis.resume();
      return setState('playing');
    }
    if (state === 'playing') {
      window.speechSynthesis.pause();
      return setState('paused');
    }
    const text = getText().replace(/\s+\n/g, '\n').trim();
    queue.current = (text.match(/[^.!?\n]+[.!?]*\s*|\n+/g) || [text]).reduce<string[]>((acc, s) => {
      const t = s.trim();
      if (!t) return acc;
      if (acc.length && (acc[acc.length - 1].length + t.length < 220)) acc[acc.length - 1] += ` ${t}`;
      else acc.push(t);
      return acc;
    }, []);
    speakFrom(0);
  };
  const stop = () => {
    window.speechSynthesis?.cancel();
    setState('idle');
  };
  const cycleRate = () => {
    const rates = [1, 1.25, 1.5, 1.75, 2, 0.85];
    const r = rates[(rates.indexOf(rateRef.current) + 1) % rates.length];
    rateRef.current = r;
    setRate(r);
    if (state === 'playing') speakFrom(idx.current);
  };
  useEffect(() => () => window.speechSynthesis?.cancel(), []);
  return { supported, state, rate, pos, play, stop, cycleRate };
}

export function Detail({ id, seed, stats, onClose, onDelete, onAsk, onOpen }: Props) {
  const { data, isLoading } = useItem(id);
  const item = data?.item || seed;
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('read');
  const [title, setTitle] = useState(item?.title || '');
  const [note, setNote] = useState(item?.note || '');
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null);
  const [noting, setNoting] = useState<{ text: string; note: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [size, changeSize] = useReaderSize();
  const [progress, setProgress] = useState(0);
  const readerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastSaved = useRef<number>(0);
  const progressRef = useRef(0);
  const speech = useSpeech(() => readerRef.current?.querySelector('.reader')?.textContent || '');

  useEffect(() => {
    setTitle(item?.title || '');
    setNote(item?.note || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, item?.title, item?.note]);

  useEffect(() => {
    setTab('read');
    setSel(null);
    setNoting(null);
    setProgress(0);
    progressRef.current = 0;
    speech.stop();
    bodyRef.current?.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Reading progress: restore where you left off, save as you read, mark read at the end.
  const markdown = data?.markdown;
  useEffect(() => {
    if (!markdown || tab !== 'read') return;
    const saved = (() => {
      try {
        return Number(localStorage.getItem(`trove-progress-${id}`)) || 0;
      } catch {
        return 0;
      }
    })();
    const p = Math.max(saved, item?.progress || 0);
    lastSaved.current = item?.progress || 0;
    if (p > 3 && p < 97) {
      requestAnimationFrame(() => {
        const body = bodyRef.current;
        const reader = readerRef.current;
        if (!body || !reader) return;
        const top = reader.offsetTop + (reader.scrollHeight * p) / 100 - body.clientHeight / 3;
        body.scrollTo({ top: Math.max(0, top) });
      });
    }
    setProgress(p);
    progressRef.current = p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown, id]);

  const persistProgress = useCallback(
    (p: number, final = false) => {
      if (!item) return;
      try {
        localStorage.setItem(`trove-progress-${item.id}`, String(Math.round(p)));
      } catch { /* private mode */ }
      if (Math.abs(p - lastSaved.current) < (final ? 2 : 10) && p < 97) return;
      lastSaved.current = p;
      const done = p >= 97;
      patchItem(item.id, { progress: Math.round(p), ...(done && !item.read ? { read: true } : {}) }).catch(() => {});
    },
    [item],
  );

  // Save where you stopped when the panel closes or switches item.
  useEffect(() => {
    const itemId = id;
    return () => {
      const p = Math.round(progressRef.current);
      if (p <= 0 || Math.abs(p - lastSaved.current) < 2) return;
      try {
        localStorage.setItem(`trove-progress-${itemId}`, String(p));
      } catch { /* private mode */ }
      patchItem(itemId, { progress: p }).catch(() => {});
    };
  }, [id]);

  const onScroll = () => {
    if (sel) setSel(null);
    if (tab !== 'read') return;
    const body = bodyRef.current;
    const reader = readerRef.current;
    if (!body || !reader || !markdown) return;
    const seen = body.scrollTop + body.clientHeight - reader.offsetTop;
    const p = Math.max(0, Math.min(100, (seen / Math.max(1, reader.scrollHeight)) * 100));
    if (Math.abs(p - progress) >= 1) {
      setProgress(p);
      progressRef.current = p;
      persistProgress(p);
    }
  };

  const related = useSWR<{ items: Item[] }>(tab === 'related' ? `/api/items/${id}/related?limit=12` : null, (u: string) => api(u), { revalidateOnFocus: false });

  if (!item) return null;
  const highlights = highlightEntries(data?.markdown);

  const save = async (patch: Partial<Item>) => {
    try {
      await patchItem(item.id, patch);
    } catch (e: any) {
      toast.push({ text: `Couldn’t save: ${e.message}` });
    }
  };

  const onSelect = () => {
    const s = window.getSelection();
    const text = s?.toString().trim() || '';
    if (!text || text.length < 3 || !readerRef.current?.contains(s!.anchorNode)) return setSel(null);
    const r = s!.getRangeAt(0).getBoundingClientRect();
    setSel({ text, x: r.left + r.width / 2, y: r.top });
  };

  const highlight = async (text: string, hlNote?: string) => {
    setSel(null);
    setNoting(null);
    window.getSelection()?.removeAllRanges();
    const t = toast.push({ text: 'Saving highlight…', busy: true });
    try {
      await api(`/api/items/${item.id}/highlights`, { method: 'POST', json: { text, note: hlNote || undefined } });
      await mutate(`/api/items/${item.id}?content=1`);
      toast.update(t, { text: hlNote ? 'Highlight and note saved' : 'Highlight saved', busy: false });
    } catch (e: any) {
      toast.update(t, { text: `Couldn’t save the highlight: ${e.message}`, busy: false });
    }
  };

  const enrich = async (what: 'summary' | 'archive') => {
    setBusy(what);
    try {
      const r = await api<{ item: Item; skipped: string[]; errors: string[] }>('/api/enrich', { method: 'POST', json: { id: item.id } });
      await mutate(`/api/items/${item.id}?content=1`);
      refreshAll();
      const why = r.skipped[0] || r.errors[0];
      if (what === 'summary' && !r.item.summary) toast.push({ text: why ? `No summary: ${why}` : 'Nothing to summarize for this item' });
      else if (what === 'archive' && !r.item.snapshot && !r.item.archive) toast.push({ text: why ? `Couldn’t archive: ${why}` : 'This page could not be archived' });
      else toast.push({ text: what === 'summary' ? 'Summary ready' : 'Page archived' });
    } catch (e: any) {
      toast.push({ text: `Failed: ${e.message}` });
    } finally {
      setBusy(null);
    }
  };

  const savedOn = `${fmtDate(item.created)}${item.via ? ` via ${item.via}` : item.source ? ` from ${item.source}` : ''}`;
  const length = item.duration ? fmtDuration(item.duration) : item.readingTime ? `${item.readingTime} min read` : '';
  const engagement =
    item.stats?.likes !== undefined && item.stats?.likes !== null
      ? [`${item.stats.likes?.toLocaleString()} likes`, `${(item.stats.reposts ?? 0).toLocaleString()} reposts`, item.stats.views ? `${item.stats.views.toLocaleString()} views` : ''].filter(Boolean).join(' · ')
      : '';
  const hasArchive = !!(item.snapshot || item.archive);
  const canArchive = !!item.url && item.type !== 'X bookmark' && item.platform !== 'Upload';

  return (
    <aside className="panel" aria-label="Item details">
      <div className="panel-head">
        <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <X size={18} />
        </button>
        <span className="spacer" />
        <button className={`icon-btn ${item.favorite ? 'on' : ''}`} onClick={() => save({ favorite: !item.favorite })} aria-label={item.favorite ? 'Remove favorite' : 'Favorite'} aria-pressed={item.favorite} title="Favorite (F)">
          <Heart size={17} fill={item.favorite ? 'currentColor' : 'none'} />
        </button>
        <button className={`icon-btn ${item.read ? 'on' : ''}`} onClick={() => save({ read: !item.read })} aria-label={item.read ? 'Mark unread' : 'Mark read'} title={item.read ? 'Mark unread (R)' : 'Mark read (R)'}>
          {item.read ? <CheckCircle2 size={17} /> : <Circle size={17} />}
        </button>
        {speech.supported && data?.markdown && (
          <button className={`icon-btn ${speech.state !== 'idle' ? 'on' : ''}`} onClick={speech.play} aria-label={speech.state === 'playing' ? 'Pause reading aloud' : 'Listen'} title="Listen">
            {speech.state === 'playing' ? <Pause size={17} /> : <Headphones size={17} />}
          </button>
        )}
        <button
          className="icon-btn"
          onClick={() => {
            navigator.clipboard.writeText(item.url || item.notionUrl);
            toast.push({ text: 'Link copied' });
          }}
          aria-label="Copy link"
          title="Copy link"
        >
          <Copy size={16} />
        </button>
        <button className="icon-btn" onClick={() => onAsk(item)} aria-label="Ask the agent about this item" title="Ask the agent">
          <Bot size={17} />
        </button>
        <a className="icon-btn" href={item.notionUrl} target="_blank" rel="noreferrer" aria-label="Open in Notion" title="Open in Notion">
          <ExternalLink size={16} />
        </a>
        <button className="icon-btn" onClick={() => onDelete(item)} aria-label="Move to trash" title="Move to trash">
          <Trash2 size={16} />
        </button>
        {item.url && (
          <a className="btn primary" href={item.url} target="_blank" rel="noreferrer">
            Open <ArrowUpRight size={15} />
          </a>
        )}
      </div>
      {tab === 'read' && data?.markdown && <div className="read-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>}
      <div className="panel-body scroll" ref={bodyRef} onMouseUp={onSelect} onScroll={onScroll}>
        {item.cover && item.type !== 'Video' && (
          <div className="panel-cover">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.cover} alt="" />
          </div>
        )}
        <div className="panel-inner">
          <div>
            {item.url && (
              <a className="source-link" href={item.url} target="_blank" rel="noreferrer">
                <Favicon domain={item.domain} type={item.type} size={14} />
                <span>{item.url.replace(/^https?:\/\/(www\.)?/, '')}</span>
              </a>
            )}
            <textarea
              className="title-edit"
              value={title}
              rows={1}
              onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
              onBlur={() => title.trim() && title !== item.title && save({ title: title.trim() })}
              aria-label="Title"
            />
          </div>

          {item.summary ? (
            <div className="tldr">
              <Sparkles size={15} aria-hidden="true" />
              <p>{item.summary}</p>
            </div>
          ) : (
            (data?.markdown || item.excerpt) && (
              <button className="btn ghost sm tldr-make" onClick={() => enrich('summary')} disabled={busy === 'summary'}>
                {busy === 'summary' ? <span className="spinner" /> : <Sparkles size={14} />} Summarize
              </button>
            )
          )}

          {item.status === 'Broken' && (
            <div className="gone" role="note">
              <TriangleAlert size={16} />
              <span>The original page is gone.{hasArchive ? ' Your archived copy is safe.' : ''}</span>
              {hasArchive && <button className="btn sm" onClick={() => setTab('archive')}>View archived page</button>}
            </div>
          )}

          <div className="props">
            <span className="prop-label"><Folder size={15} /> Collection</span>
            <div className="prop-value">
              <CollectionInput key={item.id + (item.collection || '')} value={item.collection || ''} known={stats?.collections} onChange={(v) => save({ collection: v || null })} />
            </div>
            <span className="prop-label"><Hash size={15} /> Tags</span>
            <div className="prop-value" style={{ display: 'block' }}>
              <TagInput value={item.tags} known={stats?.tags} onChange={(tags) => save({ tags })} placeholder="Add tags" />
            </div>
            <span className="prop-label"><NotebookPen size={15} /> Note</span>
            <div className="prop-value">
              <textarea className="textarea" rows={1} placeholder="Add a note" value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== item.note && save({ note })} aria-label="Note" />
            </div>
            <span className="prop-label"><TypeIcon type={item.type} size={15} /> Type</span>
            <div className="prop-value text">{item.type}{item.platform && item.platform !== 'Web' ? ` · ${item.platform}` : ''}</div>
            {item.author && (
              <>
                <span className="prop-label"><User size={15} /> Author</span>
                <div className="prop-value text">{item.author}</div>
              </>
            )}
            {item.published && (
              <>
                <span className="prop-label"><CalendarDays size={15} /> Published</span>
                <div className="prop-value text">{fmtDate(item.published)}</div>
              </>
            )}
            <span className="prop-label"><Inbox size={15} /> Saved</span>
            <div className="prop-value text">{savedOn}</div>
            {length && (
              <>
                <span className="prop-label"><Clock size={15} /> Length</span>
                <div className="prop-value text num">{length}{progress > 3 && progress < 97 ? ` · ${Math.round(progress)}% read` : ''}</div>
              </>
            )}
            {engagement && (
              <>
                <span className="prop-label"><Heart size={15} /> Engagement</span>
                <div className="prop-value text num">{engagement}</div>
              </>
            )}
            {canArchive && (
              <>
                <span className="prop-label"><Landmark size={15} /> Archive</span>
                <div className="prop-value text">
                  {hasArchive ? (
                    <span className="archive-links">
                      {item.snapshot && <button className="inline-link" onClick={() => setTab('archive')}>Page snapshot</button>}
                      {item.snapshot && item.archive && ' · '}
                      {item.archive && <a className="inline-link" href={item.archive} target="_blank" rel="noreferrer">Wayback Machine</a>}
                    </span>
                  ) : (
                    <button className="inline-link" onClick={() => enrich('archive')} disabled={busy === 'archive'}>{busy === 'archive' ? 'Archiving…' : 'Archive this page now'}</button>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="tabs" role="tablist" aria-label="Content">
            <button className={tab === 'read' ? 'on' : ''} onClick={() => setTab('read')} role="tab" aria-selected={tab === 'read'}>
              Reader
            </button>
            {canArchive && (
              <button className={tab === 'archive' ? 'on' : ''} onClick={() => setTab('archive')} role="tab" aria-selected={tab === 'archive'}>
                Web archive
              </button>
            )}
            <button className={tab === 'highlights' ? 'on' : ''} onClick={() => setTab('highlights')} role="tab" aria-selected={tab === 'highlights'}>
              Highlights{highlights.length > 0 && <span className="count">{highlights.length}</span>}
            </button>
            <button className={tab === 'related' ? 'on' : ''} onClick={() => setTab('related')} role="tab" aria-selected={tab === 'related'}>
              Related
            </button>
          </div>

          <div ref={readerRef} role="tabpanel" style={{ ['--reader-size' as string]: `${size}px` }}>
            {tab === 'read' ? (
              isLoading && !data ? (
                <div style={{ display: 'grid', gap: 10 }} aria-label="Loading content">
                  {[92, 100, 96, 74, 100, 86].map((w, i) => (
                    <div key={i} className="skeleton" style={{ height: 14, width: `${w}%`, borderRadius: 6 }} />
                  ))}
                </div>
              ) : data?.markdown ? (
                <>
                  <div className="reader-tools">
                    <button className="icon-btn sm" onClick={() => changeSize(-1)} aria-label="Smaller text" title="Smaller text"><Minus size={14} /></button>
                    <span className="reader-size" aria-hidden="true">Aa</span>
                    <button className="icon-btn sm" onClick={() => changeSize(1)} aria-label="Larger text" title="Larger text"><Plus size={14} /></button>
                    <span className="spacer" />
                    {speech.supported && (
                      <button className="btn ghost sm" onClick={speech.play}>
                        {speech.state === 'playing' ? <Pause size={14} /> : <Play size={14} />} {speech.state === 'playing' ? 'Pause' : speech.state === 'paused' ? 'Resume' : 'Listen'}
                      </button>
                    )}
                  </div>
                  <Reader markdown={data.markdown} highlights={highlights.map((h) => h.text)} note={item.note} />
                </>
              ) : (
                <p className="muted">No archived content for this item.</p>
              )
            ) : tab === 'archive' ? (
              <div className="archive-view">
                {item.snapshot ? (
                  <>
                    <div className="archive-bar">
                      <span>A full copy of the page, stored in your Notion.</span>
                      <a className="btn sm" href={`/api/items/${item.id}/snapshot`} target="_blank" rel="noreferrer">Open full page <ArrowUpRight size={14} /></a>
                    </div>
                    <iframe className="snapshot-frame" src={`/api/items/${item.id}/snapshot`} sandbox="allow-popups allow-popups-to-escape-sandbox" title={`Archived copy of ${item.title}`} />
                  </>
                ) : (
                  <div className="empty compact">
                    <span className="empty-icon"><Landmark size={20} /></span>
                    <h2>No page snapshot yet</h2>
                    <p>Trove keeps a self-contained copy of the page in your Notion and a Wayback Machine capture, so it stays readable if the original disappears.</p>
                    <div className="actions">
                      <button className="btn primary" onClick={() => enrich('archive')} disabled={busy === 'archive'}>
                        {busy === 'archive' ? <span className="spinner" /> : <RefreshCw size={15} />} Archive now
                      </button>
                    </div>
                  </div>
                )}
                {item.archive && (
                  <p className="field-hint">
                    Also on the <a className="inline-link" href={item.archive} target="_blank" rel="noreferrer">Wayback Machine</a>.
                  </p>
                )}
              </div>
            ) : tab === 'highlights' ? (
              highlights.length ? (
                <div className="highlights-list">
                  {highlights.map((h, i) => (
                    <figure key={i} className="hl">
                      <blockquote>{h.text}</blockquote>
                      {h.note && <figcaption>{h.note}</figcaption>}
                    </figure>
                  ))}
                </div>
              ) : (
                <p className="muted" style={{ lineHeight: 1.6 }}>Select text in the reader to highlight it, with an optional note. Highlights saved from the browser extension show up here too.</p>
              )
            ) : related.isLoading ? (
              <div style={{ display: 'grid', gap: 8 }} aria-label="Loading related items">
                {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 52, borderRadius: 8 }} />)}
              </div>
            ) : related.data?.items.length ? (
              <div className="related">
                {related.data.items.map((r) => (
                  <button key={r.id} className="related-row" onClick={() => onOpen?.(r.id)}>
                    <Favicon domain={r.domain} type={r.type} size={16} />
                    <span className="t">
                      <span className="title">{r.title || r.url}</span>
                      <span className="sub">{[r.collection, r.domain, timeAgo(r.created)].filter(Boolean).join(' · ')}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted" style={{ lineHeight: 1.6 }}>{related.error ? `Couldn’t load related items: ${related.error.message}` : 'Related items appear once this item has been indexed for smart search.'}</p>
            )}
          </div>
        </div>
      </div>
      {speech.state !== 'idle' && (
        <div className="listen-bar" role="region" aria-label="Listening">
          <Headphones size={15} />
          <span className="num">{speech.pos.n ? `${speech.pos.i + 1} / ${speech.pos.n}` : ''}</span>
          <span className="spacer" />
          <button className="btn ghost sm num" onClick={speech.cycleRate} aria-label="Change speed">{speech.rate}×</button>
          <button className="icon-btn sm" onClick={speech.play} aria-label={speech.state === 'playing' ? 'Pause' : 'Resume'}>{speech.state === 'playing' ? <Pause size={15} /> : <Play size={15} />}</button>
          <button className="icon-btn sm" onClick={speech.stop} aria-label="Stop"><Square size={14} /></button>
        </div>
      )}
      {sel && !noting && (
        <div className="highlight-pop" style={{ left: sel.x, top: Math.max(10, sel.y - 48) }} onMouseDown={(e) => e.preventDefault()}>
          <button className="btn primary sm" onClick={() => highlight(sel.text)}>
            <Highlighter size={14} /> Highlight
          </button>
          <button className="btn sm" onClick={() => setNoting({ text: sel.text, note: '' })}>
            <NotebookPen size={14} /> Note
          </button>
        </div>
      )}
      {noting && (
        <form
          className="note-pop"
          onSubmit={(e) => {
            e.preventDefault();
            highlight(noting.text, noting.note.trim());
          }}
        >
          <blockquote>{noting.text.slice(0, 200)}{noting.text.length > 200 ? '…' : ''}</blockquote>
          <textarea autoFocus className="textarea" rows={2} placeholder="Your note" value={noting.note} onChange={(e) => setNoting({ ...noting, note: e.target.value })} onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && e.currentTarget.form?.requestSubmit()} />
          <div className="row-actions-inline">
            <button type="button" className="btn ghost sm" onClick={() => setNoting(null)}>Cancel</button>
            <button type="submit" className="btn primary sm"><Highlighter size={14} /> Save highlight</button>
          </div>
        </form>
      )}
    </aside>
  );
}
