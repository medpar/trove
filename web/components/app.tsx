'use client';
import { ArrowDownUp, Bot, CheckCircle2, Copy, ExternalLink, FolderInput, Heart, Image as ImageIcon, Inbox, Keyboard, LayoutGrid, List, Menu as MenuIcon, Plus, Rows3, Search, SearchX, Sparkles, Tag, Trash2, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AddDialog } from './add';
import { AgentPanel } from './agent';
import { AskPanel } from './ask';
import { FeedsView } from './feeds';
import { api, isSmartQuery, patchItem, refreshAll, removeLocal, useItems, useSmartSearch, useStats } from './api';
import { Detail } from './detail';
import { Items, Skeletons } from './items';
import { Palette } from './palette';
import { plural, Sidebar } from './sidebar';
import { CollectionInput, TagInput } from './taginput';
import type { Item, Scope, Sort, View } from './types';
import { Dialog, useHotkey, useMenu, useToast } from './ui';

const SORTS: { id: Sort; label: string }[] = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'title', label: 'Title A–Z' },
  { id: 'title_desc', label: 'Title Z–A' },
  { id: 'site', label: 'Site' },
  { id: 'published', label: 'Published date' },
];

const scopeKey = (s: Scope) => (s.value ? `${s.kind}:${s.value}` : s.kind);
function parseScope(v: string | null): Scope {
  if (!v) return { kind: 'all' };
  const i = v.indexOf(':');
  return i > 0 ? ({ kind: v.slice(0, i), value: v.slice(i + 1) } as Scope) : ({ kind: v } as Scope);
}

function titleFor(s: Scope): { title: string; plain: string } {
  const t = (title: string, plain = title) => ({ title, plain });
  switch (s.kind) {
    case 'all':
      return t('All items');
    case 'unsorted':
      return t('Unsorted');
    case 'favorites':
      return t('Favorites');
    case 'unread':
      return t('Read later');
    case 'highlights':
      return t('Highlights');
    case 'notes':
      return t('With notes');
    case 'reminders':
      return t('Reminders');
    case 'broken':
      return t('Broken links');
    case 'notag':
      return t('Untagged');
    case 'collection': {
      const parts = (s.value || '').split('/');
      return t(parts[parts.length - 1], s.value || '');
    }
    case 'tag':
      return t(`#${s.value}`);
    case 'type':
      return t(plural(s.value || ''));
    case 'source':
      return s.value === 'x' ? t('X bookmarks') : t('Library');
    case 'feeds':
      return t('Feeds');
  }
}

export default function TroveApp() {
  const toast = useToast();
  const menu = useMenu();
  const [ready, setReady] = useState(false);
  const [scope, setScope] = useState<Scope>({ kind: 'all' });
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [view, setView] = useState<View>('cards');
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [sideOpen, setSideOpen] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [bulkDialog, setBulkDialog] = useState<'move' | 'tag' | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [agent, setAgent] = useState<string | null>(null);
  const [askQ, setAskQ] = useState<string | null>(null);
  const [smart, setSmart] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const pendingDeletes = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // ---- state <-> URL ----
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    setScope(parseScope(p.get('s')));
    setInput(p.get('q') || '');
    setQ(p.get('q') || '');
    setSort((p.get('sort') as Sort) || 'newest');
    const savedView = (() => {
      try {
        return localStorage.getItem('trove-view') as View | null;
      } catch {
        return null;
      }
    })();
    setView((p.get('view') as View) || savedView || 'cards');
    setSelected(p.get('item'));
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    if (p.get('agent')) setAgent(p.get('agent') === '1' ? '' : p.get('agent'));
    if (p.get('add')) setAdding(p.get('add') === '1' ? '' : p.get('add'));
    if (p.get('ask')) setAskQ(p.get('ask') === '1' ? '' : p.get('ask'));
    try {
      if (localStorage.getItem('trove-smart') === 'off') setSmart(false);
    } catch { /* private mode */ }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const p = new URLSearchParams();
    if (scope.kind !== 'all') p.set('s', scopeKey(scope));
    if (q) p.set('q', q);
    if (sort !== 'newest') p.set('sort', sort);
    if (selected) p.set('item', selected);
    const url = `${location.pathname}${p.toString() ? `?${p}` : ''}`;
    if (url !== location.pathname + location.search) history.replaceState(null, '', url);
    document.title = `${titleFor(scope).plain} · Trove`;
  }, [ready, scope, q, sort, selected]);

  useEffect(() => {
    const t = setTimeout(() => setQ(input.trim()), 280);
    return () => clearTimeout(t);
  }, [input]);

  // ---- data ----
  const { data: stats } = useStats();
  const feedsView = scope.kind === 'feeds';
  const smartOn = smart && scope.kind === 'all' && isSmartQuery(q);
  const smartRes = useSmartSearch(q, smartOn);
  const list = useItems(scope, q, sort, !smartOn && !feedsView);
  const source = smartOn ? smartRes.data?.items || [] : list.items;
  const items = useMemo(() => source.filter((i) => !pendingDeletes.current.has(i.id)), [source]);
  const selectedItem = items.find((i) => i.id === selected);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => {
      if (e[0].isIntersecting && !smartOn && !list.done && !list.isValidating) list.setSize(list.size + 1);
    }, { rootMargin: '900px' });
    io.observe(el);
    return () => io.disconnect();
  }, [list.done, list.isValidating, list.size, list.setSize, items.length, smartOn]);

  // ---- actions ----
  const changeScope = useCallback((s: Scope) => {
    setScope(s);
    setChecked(new Set());
    setInput('');
    setQ('');
    document.querySelector('.main-scroll')?.scrollTo({ top: 0 });
  }, []);

  const changeView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem('trove-view', v);
    } catch { /* ignore */ }
  };

  const cycleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    // Flip every token at once instead of letting each transition smear the change.
    const css = document.createElement('style');
    css.textContent = '*,*::before,*::after{transition:none!important}';
    document.head.appendChild(css);
    if (next === 'dark') document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    void document.body.offsetHeight;
    requestAnimationFrame(() => css.remove());
    try {
      localStorage.setItem('trove-theme', next);
    } catch { /* private mode */ }
  };

  const toggle = async (it: Item, field: 'favorite' | 'read') => {
    try {
      await patchItem(it.id, { [field]: !it[field] });
    } catch (e: any) {
      toast.push({ text: `Couldn't update: ${e.message}` });
    }
  };

  const del = useCallback(
    (targets: Item[]) => {
      const ids = targets.map((t) => t.id);
      ids.forEach((id) => pendingDeletes.current.set(id, setTimeout(() => {
        pendingDeletes.current.delete(id);
        api(`/api/items/${id}`, { method: 'DELETE' }).catch(() => {}).finally(() => refreshAll());
      }, 5000)));
      removeLocal(ids);
      if (selected && ids.includes(selected)) setSelected(null);
      setChecked(new Set());
      toast.push({
        text: ids.length === 1 ? 'Moved to trash' : `${ids.length} items moved to trash`,
        action: {
          label: 'Undo',
          run: () => {
            ids.forEach((id) => {
              clearTimeout(pendingDeletes.current.get(id));
              pendingDeletes.current.delete(id);
            });
            refreshAll();
          },
        },
      });
    },
    [selected, toast],
  );

  const saveUrls = useCallback(
    async (urls: string[]) => {
      const defaults = scope.kind === 'collection' ? { collection: scope.value } : scope.kind === 'tag' ? { tags: [scope.value!] } : {};
      for (const url of urls.slice(0, 20)) {
        const t = toast.push({ text: `Saving ${url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48)}…`, busy: true });
        try {
          const r = await api<{ item: Item; created: boolean }>('/api/items', { method: 'POST', json: { url, ...defaults, source: 'Web app' } });
          toast.update(t, { text: r.created ? `Saved “${r.item.title.slice(0, 50)}”` : 'Already in your library', busy: false, action: { label: 'Open', run: () => setSelected(r.item.id) } });
        } catch (e: any) {
          toast.update(t, { text: `Couldn't save: ${e.message}`, busy: false });
        }
      }
      refreshAll();
    },
    [scope, toast],
  );

  const check = (it: Item, range: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (range && lastChecked) {
        const a = items.findIndex((i) => i.id === lastChecked);
        const b = items.findIndex((i) => i.id === it.id);
        if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(items[i].id);
      } else if (next.has(it.id)) next.delete(it.id);
      else next.add(it.id);
      return next;
    });
    setLastChecked(it.id);
  };

  const bulk = async (action: string, value?: unknown) => {
    const ids = [...checked];
    if (action === 'delete') return del(items.filter((i) => checked.has(i.id)));
    const t = toast.push({ text: `Updating ${ids.length} items…`, busy: true });
    try {
      const r = await api<{ done: number }>('/api/items/bulk', { method: 'POST', json: { ids, action, value } });
      toast.update(t, { text: `Updated ${r.done} items`, busy: false });
      setChecked(new Set());
      refreshAll();
    } catch (e: any) {
      toast.update(t, { text: `Bulk update failed: ${e.message}`, busy: false });
    }
  };

  const openMenu = (e: React.MouseEvent, it: Item) => {
    e.stopPropagation();
    menu.open(e, [
      { label: 'Open original', icon: <ExternalLink size={15} />, run: () => window.open(it.url, '_blank') },
      { label: 'Copy link', icon: <Copy size={15} />, run: () => navigator.clipboard.writeText(it.url) },
      { label: 'Open in Notion', icon: <ExternalLink size={15} />, run: () => window.open(it.notionUrl, '_blank') },
      'sep',
      { label: it.favorite ? 'Remove favorite' : 'Favorite', icon: <Heart size={15} />, run: () => toggle(it, 'favorite') },
      { label: it.read ? 'Mark unread' : 'Mark read', icon: <CheckCircle2 size={15} />, run: () => toggle(it, 'read') },
      { label: 'Select', icon: <CheckCircle2 size={15} />, run: () => check(it, false) },
      'sep',
      { label: 'Ask the agent about this', icon: <Bot size={15} />, run: () => setAgent(`About “${it.title}” (id ${it.id}): `) },
      'sep',
      { label: 'Delete', icon: <Trash2 size={15} />, danger: true, run: () => del([it]) },
    ], 'right');
  };

  // ---- global input: paste & drop to save ----
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const text = e.clipboardData?.getData('text/plain')?.trim() || '';
      if (!text) return;
      const urls = text.match(/https?:\/\/[^\s<>"'`]+/g) || [];
      e.preventDefault();
      if (urls.length && text.replace(/https?:\/\/[^\s<>"'`]+/g, '').trim().length < 3) saveUrls(urls);
      else setAdding(text);
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.some((t) => t === 'text/uri-list' || t === 'text/plain')) {
        e.preventDefault();
        setDragging(true);
      }
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      setDragging(false);
      const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '';
      const urls = text.match(/https?:\/\/[^\s<>"'`]+/g) || [];
      if (urls.length) {
        e.preventDefault();
        saveUrls(urls);
      }
    };
    window.addEventListener('paste', onPaste);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [saveUrls]);

  // ---- keyboard ----
  useHotkey(
    (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if (palette || adding !== null || help || bulkDialog || agent !== null || askQ !== null) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = items.findIndex((i) => i.id === selected);
      const cur = idx >= 0 ? items[idx] : null;
      const move = (d: number) => {
        const next = items[Math.max(0, Math.min(items.length - 1, (idx < 0 ? -1 : idx) + d))];
        if (next) {
          setSelected(next.id);
          document.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
        }
      };
      switch (e.key) {
        case 'Escape':
          if (checked.size) setChecked(new Set());
          else if (selected) setSelected(null);
          else if (document.activeElement === searchRef.current) searchRef.current?.blur();
          break;
        case '/':
          e.preventDefault();
          searchRef.current?.focus();
          break;
        case 'n':
        case 'a':
          e.preventDefault();
          setAdding('');
          break;
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          move(1);
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          move(-1);
          break;
        case 'o':
          if (cur?.url) window.open(cur.url, '_blank');
          break;
        case 'f':
          if (cur) toggle(cur, 'favorite');
          break;
        case 'r':
          if (cur) toggle(cur, 'read');
          break;
        case 'x':
          if (cur) check(cur, false);
          break;
        case 'Delete':
        case 'Backspace':
          if (checked.size) bulk('delete');
          else if (cur) del([cur]);
          break;
        case '1':
          changeView('cards');
          break;
        case '2':
          changeView('list');
          break;
        case '3':
          changeView('headlines');
          break;
        case '4':
          changeView('mood');
          break;
        case '?':
          setHelp(true);
          break;
      }
    },
    [items, selected, checked, palette, adding, help, bulkDialog, agent, askQ],
  );

  const head = titleFor(scope);
  const count =
    scope.kind === 'all' ? stats?.total : scope.kind === 'unsorted' ? stats?.unsorted : scope.kind === 'favorites' ? stats?.favorites : scope.kind === 'unread' ? stats?.unread
      : scope.kind === 'collection' ? stats?.collections.filter((c) => c.name === scope.value || c.name.startsWith(`${scope.value}/`)).reduce((a, c) => a + c.count, 0) : scope.kind === 'tag' ? stats?.tags.find((c) => c.name === scope.value)?.count
      : scope.kind === 'type' ? stats?.types.find((c) => c.name === scope.value)?.count : scope.kind === 'source' ? (scope.value === 'x' ? stats?.x : stats?.library) : undefined;

  const loading = smartOn ? !smartRes.data && smartRes.isLoading : !list.data && (list.isLoading || list.isValidating);
  const done = smartOn ? true : list.done;
  const toggleSmart = () => {
    setSmart((v) => {
      try {
        localStorage.setItem('trove-smart', v ? 'off' : 'on');
      } catch { /* private mode */ }
      return !v;
    });
  };

  return (
    <div className="app">
      <Sidebar stats={stats} scope={scope} onScope={changeScope} onSearch={() => setPalette(true)} onAgent={() => setAgent('')} theme={theme} onTheme={cycleTheme} open={sideOpen} onClose={() => setSideOpen(false)} />
      <main className="main">
        <div className="main-scroll scroll" onScroll={(e) => setScrolled((e.target as HTMLElement).scrollTop > 4)}>
          <header className={`topbar ${scrolled ? 'scrolled' : ''}`}>
            <div className="topbar-inner">
              <button className="icon-btn only-mobile" onClick={() => setSideOpen(true)} aria-label="Open menu">
                <MenuIcon size={19} />
              </button>
              <label className="search">
                <Search size={15} />
                <input
                  ref={searchRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    if (feedsView && e.target.value.trim()) setScope({ kind: 'all' });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setQ(input.trim());
                    if (e.key === 'Escape') {
                      setInput('');
                      setQ('');
                    }
                  }}
                  placeholder={scope.kind === 'all' ? 'Search by words or meaning' : feedsView ? 'Search your library' : `Search in ${head.plain}`}
                  aria-label="Search"
                  type="search"
                  enterKeyHint="search"
                />
                {input ? (
                  <button className="icon-btn sm" onClick={() => { setInput(''); setQ(''); }} aria-label="Clear search">
                    <X size={14} />
                  </button>
                ) : (
                  <span className="kbd hide-mobile">/</span>
                )}
              </label>
              <span className="spacer" />
              {!feedsView && <div className="seg hide-mobile" role="group" aria-label="Layout">
                {([['cards', LayoutGrid, 'Cards'], ['list', List, 'List'], ['headlines', Rows3, 'Headlines'], ['mood', ImageIcon, 'Moodboard']] as const).map(([v, I, label]) => (
                  <button key={v} className={view === v ? 'on' : ''} onClick={() => changeView(v)} aria-label={label} aria-pressed={view === v} title={label}>
                    <I size={16} />
                  </button>
                ))}
              </div>}
              {!feedsView && <button className="icon-btn" aria-label="Sort" title="Sort" onClick={(e) => menu.open(e, SORTS.map((s) => ({ label: s.label, on: sort === s.id, run: () => setSort(s.id) })), 'right')}>
                <ArrowDownUp size={17} />
              </button>}
              <button className="btn hide-mobile" onClick={() => setAgent('')}>
                <Bot size={15} /> Agent
              </button>
              <button className="btn primary" onClick={() => setAdding('')} aria-label="Add">
                <Plus size={16} /> <span className="hide-mobile">Add</span>
              </button>
            </div>
          </header>

          <div className="page-head">
            <h1 className="page-title">{head.title}</h1>
            <span className="page-count">{feedsView ? '' : smartOn ? (items.length ? `${items.length} best matches` : '') : count !== undefined && !q ? count.toLocaleString() : items.length ? `${items.length}${done ? '' : '+'}` : ''}</span>
            <span className="spacer" />
            <button className="icon-btn hide-mobile" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelp(true)}>
              <Keyboard size={17} />
            </button>
          </div>

          {(q || (scope.kind !== 'all' && !feedsView)) && (
            <div className="filters">
              {scope.kind !== 'all' && (
                <span className="filter-chip">
                  {head.plain}
                  <button onClick={() => changeScope({ kind: 'all' })} aria-label={`Remove filter ${head.plain}`}>
                    <X size={12} />
                  </button>
                </span>
              )}
              {q && (
                <span className="filter-chip">
                  “{q}”
                  <button onClick={() => { setInput(''); setQ(''); }} aria-label="Clear search">
                    <X size={12} />
                  </button>
                </span>
              )}
              {q && scope.kind === 'all' && isSmartQuery(q) && (
                <button className={`filter-chip toggle ${smartOn ? 'on' : ''}`} onClick={toggleSmart} aria-pressed={smartOn} title={smartOn ? 'Showing matches by meaning and words. Click for exact word matches only.' : 'Showing exact word matches. Click to also match by meaning.'}>
                  <Sparkles size={12} /> {smartOn ? (smartRes.data?.mode === 'keyword' ? 'Smart search unavailable' : 'Smart search') : 'Exact words'}
                </button>
              )}
              {q && (
                <button className="filter-chip toggle" onClick={() => setAskQ(q)} title="Get an answer from your library">
                  <Bot size={12} /> Ask Trove
                </button>
              )}
            </div>
          )}

          <section className="items" aria-busy={loading} aria-label="Items">
            {feedsView ? (
              <FeedsView stats={stats} onOpen={(id) => setSelected(id)} />
            ) : loading ? (
              <Skeletons view={view} />
            ) : (smartOn ? smartRes.error : list.error) && !items.length ? (
              <div className="empty" role="alert">
                <span className="empty-icon"><TriangleAlert size={20} /></span>
                <h2>Couldn’t load your library</h2>
                <p>{String((smartOn ? smartRes.error : list.error)?.message || 'Unknown error')}. Check your connection, then try again.</p>
                <div className="actions">
                  <button className="btn" onClick={() => (smartOn ? smartRes.mutate() : list.mutate())}>Try again</button>
                </div>
              </div>
            ) : !items.length ? (
              <div className="empty">
                <span className="empty-icon">{q ? <SearchX size={20} /> : <Inbox size={20} />}</span>
                <h2>{q ? 'No matches' : scope.kind === 'all' ? 'Your library is empty' : 'Nothing here yet'}</h2>
                <p>
                  {q ? (
                    <>Try fewer words, or narrow it down with <code>#tag</code>, <code>type:article</code>, <code>site:youtube.com</code> or <code>-word</code>.</>
                  ) : (
                    <>Paste a link anywhere, drop one on the window, or press <span className="kbd">N</span>. You can also save from your phone, the browser extension, the CLI and AI agents.</>
                  )}
                </p>
                {!q && (
                  <div className="actions">
                    <button className="btn primary" onClick={() => setAdding('')}><Plus size={15} /> Add a link</button>
                    <a className="btn" href="/settings">Ways to save</a>
                  </div>
                )}
              </div>
            ) : (
              <Items
                items={items}
                view={view}
                selectedId={selected}
                checked={checked}
                onOpen={(it) => setSelected(it.id)}
                onCheck={check}
                onFavorite={(it) => toggle(it, 'favorite')}
                onRead={(it) => toggle(it, 'read')}
                onMenu={openMenu}
                onTag={(t) => changeScope({ kind: 'tag', value: t })}
              />
            )}
            {!feedsView && <div ref={sentinel} style={{ height: 1 }} />}
            {!feedsView && !loading && items.length > 0 && !done && <div className="loading-more"><span className="spinner" aria-label="Loading more" /></div>}
            {!feedsView && !loading && done && items.length > 12 && <p className="end-note">{items.length.toLocaleString()} items</p>}
          </section>
        </div>
      </main>

      {selected && <Detail id={selected} seed={selectedItem} stats={stats} onClose={() => setSelected(null)} onDelete={(it) => del([it])} onAsk={(it) => setAgent(`About “${it.title}” (id ${it.id}): `)} onOpen={(id) => setSelected(id)} />}

      {checked.size > 0 && (
        <div className="bulk" role="toolbar" aria-label="Selection">
          <span className="count">{checked.size} selected</span>
          <span className="divider" />
          <button onClick={() => setBulkDialog('move')}><FolderInput size={15} /> Move</button>
          <button onClick={() => setBulkDialog('tag')}><Tag size={15} /> Tag</button>
          <button onClick={() => bulk('read')}><CheckCircle2 size={15} /> Mark read</button>
          <button onClick={() => bulk('favorite')}><Heart size={15} /> Favorite</button>
          <button onClick={() => bulk('delete')}><Trash2 size={15} /> Delete</button>
          <span className="divider" />
          <button onClick={() => setChecked(new Set(items.map((i) => i.id)))}>Select all</button>
          <button onClick={() => setChecked(new Set())} aria-label="Clear selection"><X size={15} /></button>
        </div>
      )}

      {bulkDialog && <BulkDialog kind={bulkDialog} stats={stats} count={checked.size} onClose={() => setBulkDialog(null)} onApply={(v) => { bulk(bulkDialog === 'move' ? 'move' : 'tag', v); setBulkDialog(null); }} />}
      {adding !== null && (
        <AddDialog
          initial={adding}
          stats={stats}
          defaults={scope.kind === 'collection' ? { collection: scope.value } : scope.kind === 'tag' ? { tags: [scope.value!] } : undefined}
          onClose={() => setAdding(null)}
          onOpen={(it) => setSelected(it.id)}
        />
      )}
      {agent !== null && <AgentPanel initial={agent} onClose={() => setAgent(null)} onOpen={(id) => setSelected(id)} />}
      {askQ !== null && <AskPanel initial={askQ} onClose={() => setAskQ(null)} onOpen={(id) => { setAskQ(null); setSelected(id); }} />}
      {palette && (
        <Palette
          stats={stats}
          onClose={() => setPalette(false)}
          onScope={changeScope}
          onOpen={(it) => setSelected(it.id)}
          onAdd={(t) => setAdding(t || '')}
          onAgent={(t) => setAgent(t || '')}
          onAsk={(t) => setAskQ(t || '')}
          onView={changeView}
          onTheme={cycleTheme}
          onSearch={(term) => {
            setInput(term);
            setQ(term);
          }}
        />
      )}
      {help && <Shortcuts onClose={() => setHelp(false)} />}
      {dragging && <div className="dropzone">Drop to save</div>}
      {menu.node}
    </div>
  );
}

function BulkDialog({ kind, stats, count, onClose, onApply }: { kind: 'move' | 'tag'; stats: any; count: number; onClose: () => void; onApply: (v: any) => void }) {
  const [value, setValue] = useState<string>('');
  const [tags, setTags] = useState<string[]>([]);
  return (
    <Dialog onClose={onClose} label={kind === 'move' ? 'Move items' : 'Tag items'}>
      <div className="dialog-head">
        <h3>{kind === 'move' ? `Move ${count} item${count === 1 ? '' : 's'}` : `Tag ${count} item${count === 1 ? '' : 's'}`}</h3>
        <p>{kind === 'move' ? 'Pick a collection, or type a new one. Leave it empty to move them to Unsorted.' : 'These tags are added to the tags each item already has.'}</p>
      </div>
      <div className="dialog-body">
        <div>
          <label className="field-label">{kind === 'move' ? 'Collection' : 'Tags'}</label>
          {kind === 'move' ? <CollectionInput value={value} onChange={setValue} known={stats?.collections} /> : <TagInput value={tags} onChange={setTags} known={stats?.tags} />}
        </div>
      </div>
      <div className="dialog-foot">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => onApply(kind === 'move' ? value : tags)} disabled={kind === 'tag' && !tags.length}>{kind === 'move' ? 'Move' : 'Add tags'}</button>
      </div>
    </Dialog>
  );
}

function Shortcuts({ onClose }: { onClose: () => void }) {
  const rows: [string[], string][] = [
    [['⌘', 'K'], 'Search and commands'], [['/'], 'Filter this view'], [['N'], 'Add a link or note'], [['⌘', 'V'], 'Paste a link anywhere to save it'],
    [['J'], 'Next item'], [['K'], 'Previous item'], [['O'], 'Open original'], [['F'], 'Favorite'], [['R'], 'Mark read or unread'],
    [['X'], 'Select'], [['⌫'], 'Delete, with undo'], [['1'], 'Cards'], [['2'], 'List'], [['3'], 'Headlines'], [['4'], 'Moodboard'], [['Esc'], 'Close panel or clear selection'],
  ];
  return (
    <Dialog onClose={onClose} label="Keyboard shortcuts">
      <div className="dialog-head"><h3>Keyboard shortcuts</h3></div>
      <div className="dialog-body">
        <div className="shortcuts">
          {rows.map(([k, v]) => (
            <div key={v} style={{ display: 'contents' }}>
              <span className="kbds">{k.map((x) => <span key={x} className="kbd">{x}</span>)}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
        <p className="field-hint" style={{ lineHeight: 1.7 }}>
          Search operators: <code>#tag</code> <code>-#tag</code> <code>type:video</code> <code>site:github.com</code> <code>collection:&quot;Dev/AI&quot;</code> <code>is:fav</code> <code>is:unread</code> <code>created:&gt;2025-01</code> <code>&quot;exact phrase&quot;</code> <code>-word</code> <code>match:OR</code>
        </p>
      </div>
    </Dialog>
  );
}
