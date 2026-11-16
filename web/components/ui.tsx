'use client';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AtSign, BookOpen, Check, Copy, Code2, FileText, Film, Headphones, Image as ImageIcon, Link2, MessageSquare, Newspaper, NotebookPen, Package, ScrollText,
} from 'lucide-react';
import { favicon } from './api';

// ---------- toasts ----------

type Toast = { id: number; text: ReactNode; action?: { label: string; run: () => void }; busy?: boolean; ttl?: number };
const ToastCtx = createContext<{ push: (t: Omit<Toast, 'id'>) => number; update: (id: number, t: Partial<Toast>) => void; dismiss: (id: number) => void }>(null!);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    clearTimeout(timers.current.get(id));
  }, []);
  const arm = useCallback(
    (t: Toast) => {
      clearTimeout(timers.current.get(t.id));
      if (!t.busy) timers.current.set(t.id, setTimeout(() => dismiss(t.id), t.ttl ?? (t.action ? 6000 : 3200)));
    },
    [dismiss],
  );
  const push = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = Date.now() + Math.random();
      const toast = { ...t, id };
      setToasts((list) => [...list.slice(-3), toast]);
      arm(toast);
      return id;
    },
    [arm],
  );
  const update = useCallback(
    (id: number, patch: Partial<Toast>) => {
      setToasts((list) =>
        list.map((x) => {
          if (x.id !== id) return x;
          const next = { ...x, ...patch };
          arm(next);
          return next;
        }),
      );
    },
    [arm],
  );
  return (
    <ToastCtx.Provider value={{ push, update, dismiss }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div className="toast" key={t.id}>
            {t.busy && <span className="spinner" />}
            <span>{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---------- menus ----------

export type MenuItem = { label: string; icon?: ReactNode; on?: boolean; run: () => void; danger?: boolean } | 'sep';

export function Menu({ anchor, items, onClose, align = 'left' }: { anchor: DOMRect; items: MenuItem[]; onClose: () => void; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: anchor.bottom + 6, left: align === 'right' ? anchor.right : anchor.left });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = align === 'right' ? anchor.right - w : anchor.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = anchor.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - h - 6);
    setPos({ top, left });
  }, [anchor, align]);
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [onClose]);
  return createPortal(
    <div className="menu" ref={ref} style={pos} role="menu">
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            role={it.on !== undefined ? 'menuitemradio' : 'menuitem'}
            aria-checked={it.on !== undefined ? it.on : undefined}
            className={it.danger ? 'danger' : ''}
            onClick={() => {
              it.run();
              onClose();
            }}
          >
            {it.icon}
            <span className="label">{it.label}</span>
            {it.on && <Check size={15} className="menu-check" />}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function useMenu() {
  const [state, setState] = useState<{ rect: DOMRect; items: MenuItem[]; align?: 'left' | 'right' } | null>(null);
  const open = (e: { currentTarget: Element }, items: MenuItem[], align?: 'left' | 'right') => setState({ rect: e.currentTarget.getBoundingClientRect(), items, align });
  const node = state ? <Menu anchor={state.rect} items={state.items} align={state.align} onClose={() => setState(null)} /> : null;
  return { open, node };
}

// ---------- dialog ----------

export function Dialog({ onClose, children, className = '', label, instant }: { onClose: () => void; children: ReactNode; className?: string; label: string; instant?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Move focus inside on open and give it back to the trigger on close.
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>('[autofocus], input, textarea, button') || el).focus();
    return () => prev?.focus?.();
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className={`overlay ${instant ? 'instant' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className={`dialog ${className}`} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ---------- visuals ----------

/** The site's icon. Items with no website (notes, uploads) or an icon that won't load show their type's icon instead. */
export function Favicon({ domain, type, size = 16, className = '' }: { domain: string; type?: string; size?: number; className?: string }) {
  const [err, setErr] = useState(false);
  if (err || !domain)
    return (
      <span className={className} aria-hidden="true" style={{ width: size, height: size, borderRadius: Math.max(3, Math.round(size / 5)), background: 'var(--bg-active)', color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
        <TypeIcon type={type || 'Link'} size={Math.max(9, Math.round(size * 0.68))} />
      </span>
    );
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={className} src={favicon(domain, size > 20 ? 128 : 64)} width={size} height={size} alt="" loading="lazy" onError={() => setErr(true)} />;
}

const TYPE_ICON: Record<string, typeof Link2> = {
  Article: Newspaper, Video: Film, Post: MessageSquare, Link: Link2, Image: ImageIcon, Document: FileText, Audio: Headphones,
  Repo: Code2, Note: NotebookPen, Product: Package, Paper: ScrollText, Book: BookOpen, Thread: AtSign,
};

export function TypeIcon({ type, size = 14 }: { type: string; size?: number }) {
  if (type === 'X bookmark')
    return (
      <span className="glyph" aria-hidden="true" style={{ display: 'inline-block', width: size, fontSize: Math.round(size * 0.82), lineHeight: `${size}px`, textAlign: 'center', fontWeight: 700, flex: 'none' }}>
        𝕏
      </span>
    );
  const I = TYPE_ICON[type] || Link2;
  return <I size={size} aria-hidden="true" />;
}

export const TYPE_ORDER = ['Article', 'Video', 'Post', 'X bookmark', 'Link', 'Image', 'Document', 'Audio', 'Repo', 'Paper', 'Product', 'Note'];

export const PLATFORM_TINT: Record<string, string> = {
  YouTube: '#ff3b30', X: '#1d1b18', Reddit: '#ff5700', Bluesky: '#1185fe', Mastodon: '#6364ff', GitHub: '#6e40c9', 'Hacker News': '#ff6600',
  LinkedIn: '#0a66c2', Instagram: '#e1306c', TikTok: '#25f4ee', Spotify: '#1db954', Substack: '#ff6719', Medium: '#2f2f2f', Vimeo: '#1ab7ea',
};

export const NOTION_COLORS: Record<string, string> = {
  default: '#9b9a97', gray: '#9b9a97', brown: '#a27763', orange: '#d9730d', yellow: '#cb912f', green: '#448361', blue: '#337ea9', purple: '#9065b0', pink: '#c14c8a', red: '#d44c47',
};

export function useHotkey(handler: (e: KeyboardEvent) => void, deps: unknown[]) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && e.key !== 'Escape' && !(e.metaKey || e.ctrlKey)) return;
      handler(e);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// ---------- copyable code ----------

export function CodeBox({ children }: { children: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="codebox">
      {children}
      <button
        className="icon-btn"
        aria-label={ok ? 'Copied' : 'Copy'}
        onClick={() => {
          navigator.clipboard.writeText(children);
          setOk(true);
          setTimeout(() => setOk(false), 1400);
        }}
      >
        {ok ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </div>
  );
}
