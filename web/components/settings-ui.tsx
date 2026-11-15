'use client';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

/** Building blocks for the Settings page: sections of panels, each a list of rows (what it does on the left, the control on the right). */

export type Kind = 'ok' | 'err' | 'warn' | 'off' | 'busy';

export function ago(at: number | string | null | undefined) {
  if (!at) return 'never';
  const t = typeof at === 'string' ? Date.parse(at) : at;
  const min = (Date.now() - t) / 60_000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)} min ago`;
  if (min < 60 * 24) return `${Math.round(min / 60)} h ago`;
  if (min < 60 * 24 * 30) return `${Math.round(min / 60 / 24)} d ago`;
  return new Date(t).toLocaleDateString();
}

export function Section({ id, title, desc, children }: { id: string; title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="set-section" aria-labelledby={`${id}-title`}>
      <header className="set-section-head">
        <h2 id={`${id}-title`}>{title}</h2>
        {desc && <p>{desc}</p>}
      </header>
      {children}
    </section>
  );
}

export function Panel({ title, desc, foot, children }: { title?: ReactNode; desc?: ReactNode; foot?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-panel">
      {(title || desc) && (
        <div className="set-panel-head">
          {title && <h3>{title}</h3>}
          {desc && <p>{desc}</p>}
        </div>
      )}
      {children}
      {foot && <div className="set-panel-foot">{foot}</div>}
    </div>
  );
}

/** One setting. `inline` keeps the control beside the text on phones too (for small icon buttons). */
export function Row({ icon, title, desc, status, inline, children }: { icon?: ReactNode; title: ReactNode; desc?: ReactNode; status?: ReactNode; inline?: boolean; children?: ReactNode }) {
  return (
    <div className={`set-row${inline ? ' inline' : ''}`}>
      {icon && (
        <span className="set-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        {desc && <div className="set-row-desc">{desc}</div>}
        {status}
      </div>
      {children && <div className="set-row-control">{children}</div>}
    </div>
  );
}

/** A status line with a coloured dot. `live` announces changes (results of something the user just did). */
export function Status({ kind, live, children }: { kind?: Kind; live?: boolean; children: ReactNode }) {
  return (
    <span className={`set-status${kind ? ` ${kind}` : ''}`} role={live ? 'status' : undefined}>
      <span className="set-dot" aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

/** Progressive disclosure for the less common path. */
export function More({ summary, bare, children }: { summary: ReactNode; bare?: boolean; children: ReactNode }) {
  return (
    <details className={`set-more${bare ? ' bare' : ''}`}>
      <summary>
        <ChevronRight size={15} aria-hidden="true" />
        {summary}
      </summary>
      <div className="set-more-body">{children}</div>
    </details>
  );
}

/** A segmented control on native radios, so arrow keys and screen readers work for free. */
export function Segmented<T extends string>({ name, label, value, options, onChange }: { name: string; label: string; value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="set-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className={value === o.value ? 'on' : undefined}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <input type="checkbox" role="switch" className="set-switch" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />;
}
