'use client';
import { Check, CircleAlert } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, patchItem, useStats } from '@/components/api';
import { CollectionInput, TagInput } from '@/components/taginput';
import type { Item } from '@/components/types';
import { Favicon } from '@/components/ui';

export default function QuickSave() {
  const p = useSearchParams();
  const [state, setState] = useState<'saving' | 'saved' | 'exists' | 'error'>('saving');
  const [item, setItem] = useState<Item | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const { data: stats } = useStats();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const url = p.get('url') || p.get('link') || '';
    const text = p.get('text') || '';
    const title = p.get('title') || '';
    const body = {
      url: url || undefined,
      text: !url ? [title, text].filter(Boolean).join('\n') : text || undefined,
      title: url && title ? title : undefined,
      tags: p.get('tags') || undefined,
      collection: p.get('collection') || undefined,
      highlight: p.get('highlight') || undefined,
      source: p.get('source') || (document.referrer ? 'Bookmarklet' : 'Share'),
    };
    api<{ item: Item; created: boolean }>('/api/items', { method: 'POST', json: body })
      .then((r) => {
        setItem(r.item);
        setNote(r.item.note);
        setState(r.created ? 'saved' : 'exists');
      })
      .catch((e) => {
        setErr(e.message);
        setState('error');
      });
  }, [p]);

  const close = () => {
    if (window.opener || history.length <= 1) window.close();
    else location.href = '/';
  };

  return (
    <div className="dialog quick-save">
      <div className="dialog-head" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {state === 'saving' ? <span className="spinner" style={{ color: 'var(--text-3)' }} /> : state === 'error' ? <CircleAlert size={18} className="err-icon" /> : <Check size={18} className="ok-icon" />}
        <h3 role="status">{state === 'saving' ? 'Saving to Trove…' : state === 'saved' ? 'Saved to Trove' : state === 'exists' ? 'Already in your library' : 'Couldn’t save this'}</h3>
      </div>
      <div className="dialog-body">
        {state === 'error' && <p className="form-error">{err}. Try again, or open Trove and add it there.</p>}
        {item && (
          <>
            <div className="quick-item">
              <Favicon domain={item.domain} type={item.type} size={20} />
              <div style={{ minWidth: 0 }}>
                <div className="t">{item.title}</div>
                <div className="d">{item.domain}</div>
              </div>
            </div>
            <div>
              <label className="field-label">Collection</label>
              <CollectionInput value={item.collection || ''} known={stats?.collections} onChange={(v) => patchItem(item.id, { collection: v || null }).then(setItem)} />
            </div>
            <div>
              <label className="field-label">Tags</label>
              <TagInput value={item.tags} known={stats?.tags} onChange={(tags) => { setItem({ ...item, tags }); patchItem(item.id, { tags }); }} />
            </div>
            <div>
              <label className="field-label" htmlFor="qs-note">Note</label>
              <textarea id="qs-note" className="textarea" value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== item.note && patchItem(item.id, { note })} placeholder="Optional" />
            </div>
          </>
        )}
      </div>
      <div className="dialog-foot">
        <a className="btn ghost" href={item ? `/?item=${item.id}` : '/'}>Open Trove</a>
        <button className="btn primary" onClick={close} disabled={state === 'saving'}>Done</button>
      </div>
    </div>
  );
}
