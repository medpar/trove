'use client';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { CornerDownLeft, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { Item } from './types';
import { Dialog, Favicon } from './ui';

type Answer = { answer: string; sources: Item[] };

const SUGGESTIONS = ['What have I saved about pricing?', 'Summarize what I saved this week', 'Which tools did I save for AI agents?', 'Find the article about…'];

/** Ask a question; the answer comes from your saved items, with numbered sources. */
export function AskPanel({ initial = '', onClose, onOpen }: { initial?: string; onClose: () => void; onOpen: (id: string) => void }) {
  const [q, setQ] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Answer | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ran = useRef(false);

  const run = async (question = q) => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      setRes(await api<Answer>('/api/ask', { method: 'POST', json: { question: question.trim() } }));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initial && !ran.current) {
      ran.current = true;
      run(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const html = useMemo(() => {
    if (!res) return '';
    const withCites = res.answer.replace(/\[(\d+)\]/g, (m, n) => (res.sources[Number(n) - 1] ? `<button class="cite" data-n="${n}">${n}</button>` : m));
    return DOMPurify.sanitize(marked.parse(withCites, { async: false }) as string, { ADD_ATTR: ['data-n'] });
  }, [res]);

  return (
    <Dialog onClose={onClose} label="Ask your library" className="ask">
      <form
        className="ask-input"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <Sparkles size={17} />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask anything about what you saved" aria-label="Question" />
        {busy ? <span className="spinner" aria-label="Thinking" /> : <button className="icon-btn sm" type="submit" aria-label="Ask"><CornerDownLeft size={15} /></button>}
      </form>
      <div className="ask-body scroll">
        {!res && !busy && !err && (
          <div className="ask-suggest">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chip-btn" onClick={() => (s.endsWith('…') ? setQ(s.replace('…', ' ')) : (setQ(s), run(s)))}>{s}</button>
            ))}
          </div>
        )}
        {busy && (
          <div style={{ display: 'grid', gap: 10 }} aria-label="Thinking">
            {[96, 88, 100, 62].map((w, i) => <div key={i} className="skeleton" style={{ height: 13, width: `${w}%`, borderRadius: 6 }} />)}
          </div>
        )}
        {err && <p className="muted" role="alert">{err}</p>}
        {res && (
          <>
            <div
              className="ask-answer"
              dangerouslySetInnerHTML={{ __html: html }}
              onClick={(e) => {
                const n = (e.target as HTMLElement).closest('.cite')?.getAttribute('data-n');
                const s = n ? res.sources[Number(n) - 1] : null;
                if (s) onOpen(s.id);
              }}
            />
            {res.sources.length > 0 && (
              <div className="ask-sources">
                <div className="field-label">Sources</div>
                {res.sources.map((s, i) => (
                  <button key={s.id} className="related-row" onClick={() => onOpen(s.id)}>
                    <span className="cite static">{i + 1}</span>
                    <Favicon domain={s.domain} size={16} />
                    <span className="t">
                      <span className="title">{s.title || s.url}</span>
                      <span className="sub">{[s.collection, s.domain].filter(Boolean).join(' · ')}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
