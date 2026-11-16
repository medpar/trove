'use client';
import { Check, CircleAlert, CornerDownLeft, Link2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, refreshAll } from './api';
import { CollectionInput, TagInput } from './taginput';
import type { Item, Stats } from './types';
import { Dialog, Favicon } from './ui';

type Status = { key: string; label: string; state: 'wait' | 'saving' | 'saved' | 'exists' | 'error'; item?: Item; error?: string };

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

export function AddDialog({ initial = '', defaults, stats, onClose, onOpen }: { initial?: string; defaults?: { collection?: string; tags?: string[] }; stats?: Stats; onClose: () => void; onOpen: (it: Item) => void }) {
  const [text, setText] = useState(initial);
  const [collection, setCollection] = useState(defaults?.collection || '');
  const [tags, setTags] = useState<string[]>(defaults?.tags || []);
  const [note, setNote] = useState('');
  const [full, setFull] = useState(true);
  const [rows, setRows] = useState<Status[] | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ta.current?.focus();
    if (!initial && navigator.clipboard?.readText) {
      navigator.clipboard
        .readText()
        .then((c) => {
          if (/^https?:\/\/\S+$/.test(c.trim())) setText((t) => t || c.trim());
        })
        .catch(() => {});
    }
  }, [initial]);

  const urls = useMemo(() => [...new Set(text.match(URL_RE) || [])], [text]);
  const isNote = urls.length === 0 && text.trim().length > 0;
  const busy = rows?.some((r) => r.state === 'saving' || r.state === 'wait');

  const submit = async () => {
    if (!text.trim() || busy) return;
    const common = { collection: collection || undefined, tags, note: note || undefined, archive: full, source: 'Web app' };
    const jobs: Status[] = isNote || urls.length === 1 ? [{ key: '0', label: urls[0] || text.trim().slice(0, 80), state: 'wait' }] : urls.map((u, i) => ({ key: String(i), label: u, state: 'wait' as const }));
    setRows(jobs);
    const set = (i: number, s: Partial<Status>) => setRows((r) => r!.map((x, j) => (j === i ? { ...x, ...s } : x)));
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, jobs.length) }, async () => {
        while (next < jobs.length) {
          const i = next++;
          set(i, { state: 'saving' });
          try {
            const body = isNote ? { text: text.trim(), ...common } : urls.length === 1 ? { text: text.trim(), url: urls[0], ...common } : { url: urls[i], ...common };
            const r = await api<{ item: Item; created: boolean }>('/api/items', { method: 'POST', json: body });
            set(i, { state: r.created ? 'saved' : 'exists', item: r.item, label: r.item.title || jobs[i].label });
          } catch (e: any) {
            set(i, { state: 'error', error: e.message });
          }
        }
      }),
    );
    refreshAll();
  };

  const done = rows && !busy;
  const savedOne = done && rows!.length === 1 && rows![0].item;

  return (
    <Dialog onClose={onClose} label="Add to Trove">
      <div className="dialog-head">
        <h3>Add to Trove</h3>
        <p>Paste one or more links, or write a note.</p>
      </div>
      <div className="dialog-body">
        {!rows ? (
          <>
            <textarea
              ref={ta}
              className="textarea"
              style={{ minHeight: 104, fontSize: 'var(--fs-md)' }}
              placeholder="https://… or a thought worth keeping"
              aria-label="Links or note"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && submit()}
            />
            <div className="grid-2">
              <div>
                <label className="field-label">Collection</label>
                <CollectionInput value={collection} onChange={setCollection} known={stats?.collections} />
              </div>
              <div>
                <label className="field-label" htmlFor="add-note">Note</label>
                <input id="add-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
              </div>
            </div>
            <div>
              <label className="field-label">Tags</label>
              <TagInput value={tags} onChange={setTags} known={stats?.tags} />
            </div>
            <label className="check-row">
              <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} />
              <span>Archive the full content (article text, transcript, images). Turn off for faster bulk adds.</span>
            </label>
          </>
        ) : (
          <div className="save-rows" role="status">
            {rows.map((r) => (
              <div key={r.key} className="save-row">
                {r.state === 'saving' || r.state === 'wait' ? (
                  <span className="spinner" style={{ color: 'var(--text-3)', opacity: r.state === 'wait' ? 0.4 : 1 }} />
                ) : r.state === 'error' ? (
                  <CircleAlert size={15} className="err-icon" />
                ) : (
                  <Check size={15} className="ok-icon" />
                )}
                {r.item ? <Favicon domain={r.item.domain} type={r.item.type} size={16} /> : <Link2 size={14} />}
                <span className="label">{r.label}</span>
                <span className={`state ${r.state === 'error' ? 'error' : ''}`}>
                  {r.state === 'saved' ? 'Saved' : r.state === 'exists' ? 'Already saved' : r.state === 'error' ? r.error : r.state === 'saving' ? 'Archiving…' : 'Waiting'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="dialog-foot">
        {!rows && <span className="hint">{urls.length > 1 ? `${urls.length} links` : urls.length === 1 ? '1 link' : isNote ? 'Saves as a note' : ''}</span>}
        {savedOne && (
          <button className="btn" onClick={() => { onOpen(rows![0].item!); onClose(); }}>
            Open item
          </button>
        )}
        <button className="btn ghost" onClick={onClose}>
          {done ? 'Close' : 'Cancel'}
        </button>
        {!rows && (
          <button className="btn primary" onClick={submit} disabled={!text.trim()}>
            Save <span className="kbd">⌘<CornerDownLeft size={10} /></span>
          </button>
        )}
      </div>
    </Dialog>
  );
}
