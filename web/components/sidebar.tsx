'use client';
import {
  AlarmClock, Bot, BookmarkCheck, ChevronRight, Folder, FolderOpen, Hash, Headphones, Heart, Highlighter, Inbox, Layers, Link2Off, Moon, NotebookPen, Rss, Search, Settings, Sun, Tags, X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Scope, Stats } from './types';
import { NOTION_COLORS, TypeIcon, TYPE_ORDER } from './ui';

type Props = {
  stats?: Stats;
  scope: Scope;
  onScope: (s: Scope) => void;
  onSearch: () => void;
  onAgent: () => void;
  theme: 'light' | 'dark';
  onTheme: () => void;
  open: boolean;
  onClose: () => void;
};

const PLURAL: Record<string, string> = { 'X bookmark': 'X bookmarks', Article: 'Articles', Video: 'Videos', Post: 'Posts', Link: 'Links', Image: 'Images', Document: 'Documents', Audio: 'Audio', Repo: 'Repos', Paper: 'Papers', Product: 'Products', Note: 'Notes' };
export const plural = (t: string) => PLURAL[t] || t;

const TAG_PREVIEW = 12;

export function Sidebar({ stats, scope, onScope, onSearch, onAgent, theme, onTheme, open, onClose }: Props) {
  const [allTags, setAllTags] = useState(false);
  const is = (k: Scope['kind'], v?: string) => scope.kind === k && (v === undefined || scope.value === v);
  const nav = (s: Scope) => {
    onScope(s);
    onClose();
  };

  // Collections form a tree by "/" in their names. Parents count everything inside them,
  // and a parent that only exists through its children still gets a row.
  const tree = useMemo(() => {
    type Node = { name: string; label: string; own: number; total: number; color: string; children: Node[] };
    const byName = new Map<string, Node>();
    const roots: Node[] = [];
    const node = (name: string): Node => {
      let n = byName.get(name);
      if (n) return n;
      const parts = name.split('/');
      n = { name, label: parts[parts.length - 1].trim(), own: 0, total: 0, color: 'default', children: [] };
      byName.set(name, n);
      if (parts.length > 1) node(parts.slice(0, -1).join('/')).children.push(n);
      else roots.push(n);
      return n;
    };
    for (const c of stats?.collections || []) {
      const n = node(c.name);
      n.own = c.count;
      n.color = c.color;
    }
    const sum = (n: Node): number => (n.total = n.own + n.children.reduce((a, c) => a + sum(c), 0));
    const sort = (list: Node[]) => list.sort((a, b) => a.label.localeCompare(b.label)).forEach((n) => sort(n.children));
    roots.forEach(sum);
    sort(roots);
    return roots;
  }, [stats]);

  // Collapsed by default; the path to the open collection is always expanded.
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      setUnfolded(new Set(JSON.parse(localStorage.getItem('trove-open-collections') || '[]')));
    } catch { /* private mode */ }
  }, []);
  const toggle = (name: string) =>
    setUnfolded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try {
        localStorage.setItem('trove-open-collections', JSON.stringify([...next]));
      } catch { /* private mode */ }
      return next;
    });
  const activePath = scope.kind === 'collection' ? scope.value || '' : '';
  const expanded = (name: string) => unfolded.has(name) || activePath.startsWith(`${name}/`);

  const tags = stats?.tags || [];
  const types = [...(stats?.types || [])].sort((a, b) => TYPE_ORDER.indexOf(a.name) - TYPE_ORDER.indexOf(b.name));

  const Item = ({ s, icon, label, count }: { s: Scope; icon: React.ReactNode; label: string; count?: number }) => {
    const active = is(s.kind, s.value);
    return (
      <button className={`nav ${active ? 'active' : ''}`} onClick={() => nav(s)} aria-current={active ? 'page' : undefined}>
        {icon}
        <span className="label">{label}</span>
        {count !== undefined && <span className="count">{count.toLocaleString()}</span>}
      </button>
    );
  };

  type TreeNode = (typeof tree)[number];
  const CollectionRow = ({ node, depth }: { node: TreeNode; depth: number }) => {
    const active = is('collection', node.name);
    const color = node.color && node.color !== 'default' ? NOTION_COLORS[node.color] : undefined;
    const hasKids = node.children.length > 0;
    const isOpen = hasKids && expanded(node.name);
    return (
      <>
        <div className={`nav-row ${active ? 'active' : ''}`} style={{ paddingInlineStart: depth * 14 }}>
          {hasKids ? (
            <button className="nav-toggle" onClick={() => toggle(node.name)} aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${node.label}`}>
              <ChevronRight size={14} style={{ rotate: isOpen ? '90deg' : '0deg' }} />
            </button>
          ) : (
            <span className="nav-toggle" aria-hidden="true" />
          )}
          <button className={`nav ${active ? 'active' : ''}`} onClick={() => nav({ kind: 'collection', value: node.name })} aria-current={active ? 'page' : undefined} title={node.name}>
            {active || isOpen ? <FolderOpen size={16} style={color ? { color } : undefined} /> : <Folder size={16} style={color ? { color } : undefined} />}
            <span className="label">{node.label}</span>
            <span className="count">{node.total.toLocaleString()}</span>
          </button>
        </div>
        {isOpen && node.children.map((c) => <CollectionRow key={c.name} node={c} depth={depth + 1} />)}
      </>
    );
  };

  return (
    <>
      {open && <div className="scrim only-mobile" onClick={onClose} />}
      <aside className={`side ${open ? 'open' : ''}`} aria-label="Library">
        <div className="side-head">
          <div className="brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icons/logo.svg" alt="" />
            Trove
          </div>
          <span style={{ flex: 1 }} />
          <button className="icon-btn sm only-mobile" onClick={onClose} aria-label="Close menu">
            <X size={16} />
          </button>
        </div>
        <button className="side-search" onClick={onSearch}>
          <Search size={15} />
          <span>Search</span>
          <span className="kbd">⌘K</span>
        </button>
        <nav className="side-body scroll">
          <Item s={{ kind: 'all' }} icon={<Layers size={16} />} label="All items" count={stats?.total} />
          <Item s={{ kind: 'unsorted' }} icon={<Inbox size={16} />} label="Unsorted" count={stats?.unsorted} />
          <Item s={{ kind: 'unread' }} icon={<BookmarkCheck size={16} />} label="Read later" count={stats?.unread} />
          <Item s={{ kind: 'favorites' }} icon={<Heart size={16} />} label="Favorites" count={stats?.favorites} />
          {!!stats?.highlights && <Item s={{ kind: 'highlights' }} icon={<Highlighter size={16} />} label="Highlights" count={stats.highlights} />}
          {!!stats?.notes && <Item s={{ kind: 'notes' }} icon={<NotebookPen size={16} />} label="With notes" count={stats.notes} />}
          {!!stats?.reminders && <Item s={{ kind: 'reminders' }} icon={<AlarmClock size={16} />} label="Reminders" count={stats.reminders} />}
          <Item s={{ kind: 'feeds' }} icon={<Rss size={16} />} label="Feeds" />
          <Item s={{ kind: 'shows' }} icon={<Headphones size={16} />} label="Shows" />

          <div className="side-section">
            <div className="side-title">Collections</div>
            {tree.length === 0 && <p className="side-empty">Give any item a collection to start one.</p>}
            {tree.map((n) => (
              <CollectionRow key={n.name} node={n} depth={0} />
            ))}
          </div>

          {types.length > 0 && (
            <div className="side-section">
              <div className="side-title">Types</div>
              {types.map((t) => (
                <Item key={t.name} s={{ kind: 'type', value: t.name }} icon={<TypeIcon type={t.name} size={16} />} label={plural(t.name)} count={t.count} />
              ))}
            </div>
          )}

          {tags.length > 0 && (
            <div className="side-section">
              <div className="side-title">
                <span>Tags</span>
                {tags.length > TAG_PREVIEW && (
                  <button className="btn ghost sm" onClick={() => setAllTags(!allTags)} aria-expanded={allTags}>
                    {allTags ? 'Show less' : `All ${tags.length}`}
                  </button>
                )}
              </div>
              {(allTags ? tags : tags.slice(0, TAG_PREVIEW)).map((t) => (
                <Item key={t.name} s={{ kind: 'tag', value: t.name }} icon={<Hash size={15} />} label={t.name} count={t.count} />
              ))}
            </div>
          )}

          <div className="side-section">
            <div className="side-title">Maintenance</div>
            {!!stats?.noTags && <Item s={{ kind: 'notag' }} icon={<Tags size={16} />} label="Untagged" count={stats.noTags} />}
            <Item s={{ kind: 'broken' }} icon={<Link2Off size={16} />} label="Broken links" count={stats?.broken} />
          </div>
        </nav>
        <div className="side-foot">
          <a className="icon-btn" href="/settings" aria-label="Settings" title="Settings">
            <Settings size={17} />
          </a>
          <button className="icon-btn" onClick={onTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button className="icon-btn" onClick={onAgent} aria-label="Agent" title="Agent">
            <Bot size={17} />
          </button>
          <span className="total">{stats ? `${stats.total.toLocaleString()} saved` : ''}</span>
        </div>
      </aside>
    </>
  );
}
