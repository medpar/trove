'use client';
import { ArrowUpRight, Check, CheckCircle2, Circle, Heart, MoreHorizontal, Play } from 'lucide-react';
import { memo, useState } from 'react';
import { fmtDuration, timeAgo } from './api';
import type { Item, View } from './types';
import { Favicon, TypeIcon } from './ui';

export type ItemHandlers = {
  onOpen: (it: Item) => void;
  onCheck: (it: Item, range: boolean) => void;
  onFavorite: (it: Item) => void;
  onRead: (it: Item) => void;
  onMenu: (e: React.MouseEvent, it: Item) => void;
  onTag: (tag: string) => void;
};

type Props = ItemHandlers & { items: Item[]; view: View; selectedId: string | null; checked: Set<string> };

const open = (it: Item, e: React.MouseEvent, h: ItemHandlers) => (e.metaKey || e.ctrlKey ? window.open(it.url || it.notionUrl, '_blank', 'noopener') : h.onOpen(it));
const isX = (it: Item) => it.type === 'X bookmark';
const host = (it: Item) => (isX(it) ? it.author.split(' ').pop() || 'x.com' : it.domain);

function Cover({ it }: { it: Item }) {
  const [broken, setBroken] = useState(false);
  if (it.cover && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={it.cover} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />;
  }
  return (
    <div className="cover-fallback">
      <span className="fav-tile">
        <Favicon domain={it.domain} size={24} />
      </span>
      <span className="host">{it.domain || it.type}</span>
    </div>
  );
}

function badge(it: Item) {
  if (isX(it) && it.stats?.thread && it.stats.thread > 1) return `Thread · ${it.stats.thread}`;
  if (it.type === 'Video' && it.duration) return <><Play size={10} fill="currentColor" strokeWidth={0} />{fmtDuration(it.duration)}</>;
  if (it.readingTime) return `${it.readingTime} min`;
  return null;
}

const Meta = ({ it }: { it: Item }) => (
  <div className="meta">
    <Favicon domain={it.domain} size={14} />
    <span className="host">{host(it)}</span>
    <span className="sep" aria-hidden="true">·</span>
    <TypeIcon type={it.type} size={12} />
    <span className="sep" aria-hidden="true">·</span>
    <time dateTime={it.created} title={new Date(it.created).toLocaleString()}>{timeAgo(it.created)}</time>
    {it.status === 'Broken' && <span className="chip danger">Broken</span>}
    {it.favorite && <Heart size={12} fill="currentColor" className="fav-mark" aria-label="Favorite" />}
  </div>
);

const Tags = ({ it, onTag, max = 3 }: { it: Item; onTag: (t: string) => void; max?: number }) =>
  it.tags.length ? (
    <div className="tags">
      {it.tags.slice(0, max).map((t) => (
        <button
          key={t}
          className="tag"
          onClick={(e) => {
            e.stopPropagation();
            onTag(t);
          }}
        >
          #{t}
        </button>
      ))}
      {it.tags.length > max && <span className="tag" style={{ background: 'none' }}>+{it.tags.length - max}</span>}
    </div>
  ) : null;

function Actions({ it, h }: { it: Item; h: ItemHandlers }) {
  return (
    <div className="card-actions" onClick={(e) => e.stopPropagation()}>
      <button className={it.favorite ? 'on' : ''} aria-label={it.favorite ? 'Remove favorite' : 'Favorite'} aria-pressed={it.favorite} onClick={() => h.onFavorite(it)}>
        <Heart size={15} fill={it.favorite ? 'currentColor' : 'none'} />
      </button>
      <button aria-label={it.read ? 'Mark unread' : 'Mark read'} onClick={() => h.onRead(it)}>
        {it.read ? <CheckCircle2 size={15} /> : <Circle size={15} />}
      </button>
      {it.url && (
        <button aria-label="Open original" onClick={() => window.open(it.url, '_blank', 'noopener')}>
          <ArrowUpRight size={15} />
        </button>
      )}
      <button aria-label="More actions" onClick={(e) => h.onMenu(e, it)}>
        <MoreHorizontal size={15} />
      </button>
    </div>
  );
}

function CheckBox({ checked, it, h }: { checked: boolean; it: Item; h: ItemHandlers }) {
  return (
    <button
      className={`check ${checked ? 'on' : ''}`}
      aria-label={checked ? 'Deselect' : 'Select'}
      aria-pressed={checked}
      onClick={(e) => {
        e.stopPropagation();
        h.onCheck(it, e.shiftKey);
      }}
    >
      {checked && <Check size={13} className="strong" />}
    </button>
  );
}

const CardView = memo(function CardView({ it, selected, checked, h }: { it: Item; selected: boolean; checked: boolean; h: ItemHandlers }) {
  // Text posts and notes without media read better as text than behind a placeholder cover.
  const textual = !it.cover && (it.type === 'Post' || it.type === 'Note' || isX(it));
  const b = badge(it);
  const cls = `card ${textual ? 'textual' : ''} ${selected ? 'selected' : ''} ${checked ? 'checked' : ''} ${it.read ? 'is-read' : ''}`;
  if (textual) {
    const text = it.excerpt || it.title;
    const showTitle = it.type === 'Note' && it.title && !text.startsWith(it.title.slice(0, 40));
    return (
      <article className={cls} onClick={(e) => open(it, e, h)} data-id={it.id}>
        <CheckBox checked={checked} it={it} h={h} />
        <Actions it={it} h={h} />
        <div className="card-body">
          <div className="card-author">
            <Favicon domain={it.domain} size={16} />
            <span>{it.author || host(it)}</span>
          </div>
          {showTitle && <h3 className="card-title">{it.title}</h3>}
          <p className="card-text">{text}</p>
          {it.note && <p className="card-note">{it.note}</p>}
          <div className="footer">
            <Tags it={it} onTag={h.onTag} />
            <Meta it={it} />
          </div>
        </div>
      </article>
    );
  }
  const blurb = it.summary || (it.excerpt && it.excerpt !== it.title ? it.excerpt : '');
  const reading = it.progress && it.progress > 3 && it.progress < 97 ? it.progress : 0;
  return (
    <article className={cls} onClick={(e) => open(it, e, h)} data-id={it.id}>
      <div className="cover">
        <Cover it={it} />
        {b && <span className="cover-badge">{b}</span>}
        {reading > 0 && <span className="cover-progress" aria-label={`${Math.round(reading)}% read`}><span style={{ width: `${reading}%` }} /></span>}
      </div>
      <CheckBox checked={checked} it={it} h={h} />
      <Actions it={it} h={h} />
      <div className="card-body">
        <h3 className="card-title">{it.title || it.url}</h3>
        {blurb && <p className={`card-excerpt ${it.summary ? 'is-summary' : ''}`}>{blurb}</p>}
        {it.note && <p className="card-note">{it.note}</p>}
        <div className="footer">
          <Tags it={it} onTag={h.onTag} />
          <Meta it={it} />
        </div>
      </div>
    </article>
  );
});

const RowView = memo(function RowView({ it, selected, checked, h }: { it: Item; selected: boolean; checked: boolean; h: ItemHandlers }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className={`row ${selected ? 'selected' : ''} ${checked ? 'checked' : ''} ${it.read ? 'is-read' : ''}`} onClick={(e) => open(it, e, h)} data-id={it.id}>
      <button
        className={`row-lead ${checked ? 'on' : ''}`}
        aria-label={checked ? 'Deselect' : 'Select'}
        aria-pressed={checked}
        onClick={(e) => {
          e.stopPropagation();
          h.onCheck(it, e.shiftKey);
        }}
      >
        {checked ? <Check size={13} className="strong" /> : <Favicon domain={it.domain} size={16} />}
      </button>
      <div className="row-main">
        <div className="row-title">{it.title || it.url}</div>
        {(it.note || it.summary || it.excerpt) && <div className="row-excerpt">{it.note || it.summary || it.excerpt}</div>}
        <div className="row-sub">
          <Meta it={it} />
          <Tags it={it} onTag={h.onTag} />
        </div>
      </div>
      <div className="row-thumb">
        {it.cover && !broken ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={it.cover} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : null}
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        <button className={`icon-btn sm ${it.favorite ? 'on' : ''}`} aria-label={it.favorite ? 'Remove favorite' : 'Favorite'} aria-pressed={it.favorite} onClick={() => h.onFavorite(it)}>
          <Heart size={15} fill={it.favorite ? 'currentColor' : 'none'} />
        </button>
        <button className="icon-btn sm" aria-label={it.read ? 'Mark unread' : 'Mark read'} onClick={() => h.onRead(it)}>
          {it.read ? <CheckCircle2 size={15} /> : <Circle size={15} />}
        </button>
        <button className="icon-btn sm" aria-label="More actions" onClick={(e) => h.onMenu(e, it)}>
          <MoreHorizontal size={15} />
        </button>
      </div>
    </div>
  );
});

const HeadlineView = memo(function HeadlineView({ it, selected, checked, h }: { it: Item; selected: boolean; checked: boolean; h: ItemHandlers }) {
  return (
    <div
      className={`headline ${selected ? 'selected' : ''} ${checked ? 'checked' : ''} ${it.read ? 'is-read' : ''}`}
      onClick={(e) => open(it, e, h)}
      onContextMenu={(e) => {
        e.preventDefault();
        h.onMenu(e, it);
      }}
      data-id={it.id}
    >
      <Favicon domain={it.domain} size={16} />
      <span className="t">
        {it.title || it.url}
        <span className="host">{host(it)}</span>
      </span>
      <span className="d">{it.tags.slice(0, 2).map((t) => `#${t}`).join(' ')}</span>
      <span className="d">{timeAgo(it.created)}</span>
    </div>
  );
});

function Tile({ it, h }: { it: Item; h: ItemHandlers }) {
  const [broken, setBroken] = useState(false);
  if (!it.cover || broken) {
    return (
      <button className="tile text" onClick={(e) => open(it, e, h)} data-id={it.id}>
        {it.title}
        <div className="meta">
          <Favicon domain={it.domain} size={14} /> <span className="host">{host(it)}</span>
        </div>
      </button>
    );
  }
  return (
    <button className="tile" onClick={(e) => open(it, e, h)} data-id={it.id} aria-label={it.title}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={it.cover} alt="" loading="lazy" onError={() => setBroken(true)} />
      <div className="cap">{it.title}</div>
    </button>
  );
}

export function Items({ items, view, selectedId, checked, ...h }: Props) {
  const handlers = h as ItemHandlers;
  if (view === 'list')
    return (
      <div className="list">
        {items.map((it) => (
          <RowView key={it.id} it={it} selected={it.id === selectedId} checked={checked.has(it.id)} h={handlers} />
        ))}
      </div>
    );
  if (view === 'headlines')
    return (
      <div className="headlines">
        {items.map((it) => (
          <HeadlineView key={it.id} it={it} selected={it.id === selectedId} checked={checked.has(it.id)} h={handlers} />
        ))}
      </div>
    );
  if (view === 'mood')
    return (
      <div className="mood">
        {items.map((it) => (
          <Tile key={it.id} it={it} h={handlers} />
        ))}
      </div>
    );
  return (
    <div className={`grid ${checked.size ? 'selecting' : ''}`}>
      {items.map((it) => (
        <CardView key={it.id} it={it} selected={it.id === selectedId} checked={checked.has(it.id)} h={handlers} />
      ))}
    </div>
  );
}

export function Skeletons({ view }: { view: View }) {
  if (view === 'cards' || view === 'mood')
    return (
      <div className="grid" aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skeleton" style={{ height: 268 }} />
        ))}
      </div>
    );
  return (
    <div style={{ display: 'grid', gap: 8 }} aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: view === 'list' ? 72 : 34, borderRadius: 8 }} />
      ))}
    </div>
  );
}
