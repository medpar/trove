'use client';
import { Check, Plus, RefreshCw, Rss, Settings2, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import { api, refreshAll, timeAgo } from './api';
import { CollectionInput } from './taginput';
import type { Item, Stats } from './types';
import { Dialog, Favicon, useToast } from './ui';

export type Feed = { id: string; url: string; title: string; site: string; collection?: string | null; autosave?: boolean; added: string; error?: string | null; count?: number };
type Entry = { id: string; feedId: string; feed: string; title: string; url: string; date: string | null; summary: string; image: string | null; author: string };

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

export function useFeeds(feedId?: string) {
  return useSWR<{ feeds: Feed[]; entries: Entry[] }>(`/api/feeds${feedId ? `?feed=${feedId}` : ''}`, (u: string) => api(u), { revalidateOnFocus: false, dedupingInterval: 60000 });
}

/** The Feeds view: latest posts from your subscriptions, saved to the library one tap at a time. */
export function FeedsView({ stats, onOpen }: { stats?: Stats; onOpen: (id: string) => void }) {
  const [feedId, setFeedId] = useState<string | undefined>();
  const { data, error, isLoading, mutate } = useFeeds(feedId);
  const all = useFeeds();
  const toast = useToast();
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [manage, setManage] = useState(false);
  const feeds = all.data?.feeds || [];

  const save = async (e: Entry) => {
    setSaving((s) => new Set(s).add(e.id));
    try {
      const feed = feeds.find((f) => f.id === e.feedId);
      const r = await api<{ item: Item; created: boolean }>('/api/items', { method: 'POST', json: { url: e.url, collection: feed?.collection || undefined, source: 'Feed', via: e.feed } });
      setSaved((s) => ({ ...s, [e.id]: r.item.id }));
      toast.push({ text: r.created ? `Saved “${r.item.title.slice(0, 50)}”` : 'Already in your library', action: { label: 'Open', run: () => onOpen(r.item.id) } });
      refreshAll();
    } catch (err: any) {
      toast.push({ text: `Couldn’t save: ${err.message}` });
    } finally {
      setSaving((s) => {
        const n = new Set(s);
        n.delete(e.id);
        return n;
      });
    }
  };

  if (!isLoading && !error && !feeds.length && !all.isLoading)
    return (
      <>
        <div className="empty">
          <span className="empty-icon"><Rss size={20} /></span>
          <h2>Follow sites, newsletters and channels</h2>
          <p>Add a blog, a Substack, a YouTube channel or any RSS feed. New posts show up here and only reach your library when you save them, unless you turn on auto-save for a feed.</p>
          <div className="actions">
            <button className="btn primary" onClick={() => setManage(true)}><Plus size={15} /> Add a feed</button>
          </div>
        </div>
        {manage && <ManageFeeds feeds={feeds} stats={stats} onClose={() => setManage(false)} onChange={() => { all.mutate(); mutate(); }} />}
      </>
    );

  return (
    <div className="feeds">
      <div className="feed-bar">
        <div className="feed-chips" role="tablist" aria-label="Feeds">
          <button className={`chip-btn ${!feedId ? 'on' : ''}`} onClick={() => setFeedId(undefined)} role="tab" aria-selected={!feedId}>All feeds</button>
          {feeds.map((f) => (
            <button key={f.id} className={`chip-btn ${feedId === f.id ? 'on' : ''}`} onClick={() => setFeedId(f.id)} role="tab" aria-selected={feedId === f.id} title={f.error ? `Couldn’t read this feed: ${f.error}` : f.url}>
              <Favicon domain={host(f.site || f.url)} size={14} />
              {f.title}
              {f.autosave && <span className="dot" title="Auto-saves into your library" />}
              {f.error && <span className="warn" aria-label="Feed error">!</span>}
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={() => mutate()} aria-label="Refresh feeds" title="Refresh"><RefreshCw size={16} /></button>
        <button className="btn" onClick={() => setManage(true)}><Settings2 size={15} /> Manage</button>
      </div>

      {isLoading && !data ? (
        <div style={{ display: 'grid', gap: 8 }} aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton" style={{ height: 76, borderRadius: 10 }} />)}
        </div>
      ) : error ? (
        <p className="muted">Couldn’t load feeds: {String(error.message || error)}</p>
      ) : (
        <div className="feed-list">
          {data?.entries.map((e) => {
            const done = saved[e.id];
            return (
              <article key={e.id} className="feed-row">
                <a className="feed-main" href={e.url} target="_blank" rel="noreferrer">
                  <span className="feed-meta">
                    <Favicon domain={host(e.url)} size={14} />
                    <span>{e.feed}</span>
                    {e.date && <><span aria-hidden="true">·</span><time dateTime={e.date}>{timeAgo(e.date)}</time></>}
                  </span>
                  <span className="feed-title">{e.title}</span>
                  {e.summary && <span className="feed-summary">{e.summary}</span>}
                </a>
                {e.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="feed-thumb" src={e.image} alt="" loading="lazy" onError={(ev) => ((ev.target as HTMLElement).style.display = 'none')} />
                )}
                <div className="feed-actions">
                  {done ? (
                    <button className="btn sm" onClick={() => onOpen(done)}><Check size={14} /> Saved</button>
                  ) : (
                    <button className="btn sm primary" onClick={() => save(e)} disabled={saving.has(e.id)}>
                      {saving.has(e.id) ? <span className="spinner" /> : <Plus size={14} />} Save
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          {!data?.entries.length && <p className="muted">No posts yet.</p>}
        </div>
      )}
      {manage && <ManageFeeds feeds={feeds} stats={stats} onClose={() => setManage(false)} onChange={() => { all.mutate(); mutate(); }} />}
    </div>
  );
}

function ManageFeeds({ feeds, stats, onClose, onChange }: { feeds: Feed[]; stats?: Stats; onClose: () => void; onChange: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [collection, setCollection] = useState('');
  const [autosave, setAutosave] = useState(false);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const r = await api<{ feed: Feed }>('/api/feeds', { method: 'POST', json: { url: url.trim(), collection: collection || undefined, autosave } });
      toast.push({ text: `Following ${r.feed.title}` });
      setUrl('');
      onChange();
    } catch (e: any) {
      toast.push({ text: `Couldn’t add it: ${e.message}` });
    } finally {
      setBusy(false);
    }
  };

  const patch = async (f: Feed, p: Partial<Feed>) => {
    try {
      await api('/api/feeds', { method: 'PATCH', json: { id: f.id, ...p } });
      onChange();
    } catch (e: any) {
      toast.push({ text: `Couldn’t update: ${e.message}` });
    }
  };

  const opml = async (file: File) => {
    try {
      const r = await api<{ added: number }>('/api/feeds', { method: 'POST', json: { opml: await file.text() } });
      toast.push({ text: `Imported ${r.added} feeds` });
      onChange();
    } catch (e: any) {
      toast.push({ text: `Import failed: ${e.message}` });
    }
  };

  return (
    <Dialog onClose={onClose} label="Manage feeds">
      <div className="dialog-head">
        <h3>Feeds</h3>
        <p>Paste a site, a Substack, a YouTube channel or a feed URL. Trove finds the feed.</p>
      </div>
      <div className="dialog-body">
        <div className="feed-add">
          <input className="input" placeholder="https://example.com or a feed URL" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} aria-label="Feed or site URL" autoFocus />
          <button className="btn primary" onClick={add} disabled={busy || !url.trim()}>{busy ? <span className="spinner" /> : <Plus size={15} />} Follow</button>
        </div>
        <div className="grid-2">
          <div>
            <label className="field-label">Save posts into</label>
            <CollectionInput value={collection} onChange={setCollection} known={stats?.collections} />
          </div>
          <label className="check-row" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={autosave} onChange={(e) => setAutosave(e.target.checked)} />
            <span>Auto-save every new post (daily)</span>
          </label>
        </div>
        {feeds.length > 0 && (
          <div className="feed-manage">
            {feeds.map((f) => (
              <div key={f.id} className="feed-manage-row">
                <Favicon domain={host(f.site || f.url)} size={16} />
                <div className="t">
                  <strong>{f.title}</strong>
                  <span className="sub">{f.error ? `Error: ${f.error}` : f.collection ? `Saves into ${f.collection}` : 'Saves into Unsorted'}</span>
                </div>
                <label className="switch" title="Auto-save new posts">
                  <input type="checkbox" checked={!!f.autosave} onChange={(e) => patch(f, { autosave: e.target.checked })} />
                  <span>Auto-save</span>
                </label>
                <button
                  className="icon-btn sm"
                  aria-label={`Unfollow ${f.title}`}
                  onClick={async () => {
                    await api(`/api/feeds?id=${f.id}`, { method: 'DELETE' }).catch(() => {});
                    onChange();
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="dialog-foot">
        <label className="btn ghost">
          <Upload size={15} /> Import OPML
          <input type="file" accept=".opml,.xml" hidden onChange={(e) => e.target.files?.[0] && opml(e.target.files[0])} />
        </label>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}
