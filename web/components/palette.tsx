'use client';
import { ArrowDown, ArrowRight, ArrowUp, Bot, BookmarkCheck, CornerDownLeft, Folder, Hash, Heart, Image as ImageIcon, Inbox, LayoutGrid, Layers, List, Moon, Plus, Rows3, Rss, Search, Settings, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, timeAgo } from './api';
import type { Item, Scope, Stats, View } from './types';
import { Dialog, Favicon } from './ui';

type Cmd = { id: string; group: string; label: string; icon: React.ReactNode; sub?: string; run: () => void };

export function Palette({ stats, onClose, onScope, onOpen, onAdd, onAgent, onAsk, onView, onTheme, onSearch }: {
  stats?: Stats;
  onClose: () => void;
  onScope: (s: Scope) => void;
  onOpen: (it: Item) => void;
  onAdd: (text?: string) => void;
  onAgent: (text?: string) => void;
  onAsk: (text?: string) => void;
  onView: (v: View) => void;
  onTheme: () => void;
  onSearch: (q: string) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || /^https?:\/\//.test(term)) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<{ items: Item[] }>(`/api/items?q=${encodeURIComponent(term)}&limit=8`, { signal: ctrl.signal })
        .then((r) => setResults(r.items))
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 220);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const cmds = useMemo<Cmd[]>(() => {
    const term = q.trim().toLowerCase();
    const match = (s: string) => !term || s.toLowerCase().includes(term);
    const close = (fn: () => void) => () => {
      fn();
      onClose();
    };
    const out: Cmd[] = [];
    if (/^https?:\/\//.test(q.trim())) out.push({ id: 'save-url', group: 'Save', label: `Save ${q.trim()}`, icon: <Plus size={16} />, run: close(() => onAdd(q.trim())) });
    else if (term) {
      out.push({ id: 'search', group: 'Search', label: `Search for “${q.trim()}”`, icon: <ArrowRight size={16} />, run: close(() => onSearch(q.trim())) });
      out.push({ id: 'ask-lib', group: 'Search', label: `Ask your library: “${q.trim()}”`, icon: <Sparkles size={16} />, run: close(() => onAsk(q.trim())) });
      out.push({ id: 'ask', group: 'Search', label: `Ask the agent: “${q.trim()}”`, icon: <Bot size={16} />, run: close(() => onAgent(q.trim())) });
    }
    const actions: Cmd[] = [
      { id: 'add', group: 'Actions', label: 'Add link or note', sub: 'N', icon: <Plus size={16} />, run: close(() => onAdd()) },
      { id: 'ask-open', group: 'Actions', label: 'Ask your library', icon: <Sparkles size={16} />, run: close(() => onAsk()) },
      { id: 'agent', group: 'Actions', label: 'Open the agent', icon: <Bot size={16} />, run: close(() => onAgent()) },
      { id: 'feeds', group: 'Go to', label: 'Feeds', icon: <Rss size={16} />, run: close(() => onScope({ kind: 'feeds' })) },
      { id: 'all', group: 'Go to', label: 'All items', icon: <Layers size={16} />, run: close(() => onScope({ kind: 'all' })) },
      { id: 'unsorted', group: 'Go to', label: 'Unsorted', icon: <Inbox size={16} />, run: close(() => onScope({ kind: 'unsorted' })) },
      { id: 'unread', group: 'Go to', label: 'Read later', icon: <BookmarkCheck size={16} />, run: close(() => onScope({ kind: 'unread' })) },
      { id: 'fav', group: 'Go to', label: 'Favorites', icon: <Heart size={16} />, run: close(() => onScope({ kind: 'favorites' })) },
      { id: 'x', group: 'Go to', label: 'X bookmarks', icon: <span className="glyph" style={{ width: 16, textAlign: 'center', fontWeight: 700 }} aria-hidden="true">𝕏</span>, run: close(() => onScope({ kind: 'type', value: 'X bookmark' })) },
      { id: 'v-cards', group: 'View', label: 'Cards view', sub: '1', icon: <LayoutGrid size={16} />, run: close(() => onView('cards')) },
      { id: 'v-list', group: 'View', label: 'List view', sub: '2', icon: <List size={16} />, run: close(() => onView('list')) },
      { id: 'v-head', group: 'View', label: 'Headlines view', sub: '3', icon: <Rows3 size={16} />, run: close(() => onView('headlines')) },
      { id: 'v-mood', group: 'View', label: 'Moodboard view', sub: '4', icon: <ImageIcon size={16} />, run: close(() => onView('mood')) },
      { id: 'theme', group: 'Actions', label: 'Switch light or dark theme', icon: <Moon size={16} />, run: close(onTheme) },
      { id: 'settings', group: 'Actions', label: 'Settings', icon: <Settings size={16} />, run: close(() => (location.href = '/settings')) },
    ];
    out.push(...actions.filter((a) => match(a.label)));
    for (const c of stats?.collections || []) if (term && match(c.name)) out.push({ id: `c-${c.name}`, group: 'Collections', label: c.name, sub: String(c.count), icon: <Folder size={16} />, run: close(() => onScope({ kind: 'collection', value: c.name })) });
    for (const t of stats?.tags || []) if (term && match(t.name)) out.push({ id: `t-${t.name}`, group: 'Tags', label: `#${t.name}`, sub: String(t.count), icon: <Hash size={16} />, run: close(() => onScope({ kind: 'tag', value: t.name })) });
    for (const it of results) out.push({ id: `i-${it.id}`, group: 'Items', label: it.title || it.url, sub: timeAgo(it.created), icon: <Favicon domain={it.domain} size={16} />, run: close(() => onOpen(it)) });
    return out.slice(0, 60);
  }, [q, stats, results, onAdd, onAgent, onAsk, onClose, onOpen, onScope, onSearch, onTheme, onView]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  let lastGroup = '';
  return (
    <Dialog onClose={onClose} className="palette" label="Command palette" instant>
      <div className="palette-input">
        <Search size={17} />
        <input
          autoFocus
          placeholder="Search, jump to a collection, or paste a link"
          aria-label="Search or run a command"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={cmds[idx] ? `cmd-${idx}` : undefined}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIdx((i) => Math.min(i + 1, cmds.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              cmds[idx]?.run();
            }
          }}
        />
        {loading && <span className="spinner" aria-label="Searching" />}
      </div>
      <div className="palette-list" ref={listRef} id="palette-list" role="listbox">
        {cmds.map((c, i) => {
          const head = c.group !== lastGroup ? <div className="palette-group">{c.group}</div> : null;
          lastGroup = c.group;
          return (
            <div key={c.id}>
              {head}
              <button id={`cmd-${i}`} role="option" aria-selected={i === idx} className={`palette-item ${i === idx ? 'on' : ''}`} onMouseMove={() => i !== idx && setIdx(i)} onClick={c.run}>
                {c.icon}
                <span className="label">{c.label}</span>
                {c.sub && <span className="sub">{c.sub}</span>}
              </button>
            </div>
          );
        })}
        {!cmds.length && !loading && <div className="palette-group">No results</div>}
      </div>
      <div className="palette-foot hide-mobile">
        <span><ArrowUp size={12} /><ArrowDown size={12} /> Navigate</span>
        <span><CornerDownLeft size={12} /> Select</span>
        <span><span className="kbd">Esc</span> Close</span>
      </div>
    </Dialog>
  );
}
