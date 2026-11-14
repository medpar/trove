'use client';
import { ArrowLeft, Command, Copy, Download, ExternalLink, Eye, EyeOff, KeyRound, Landmark, Link2, LogOut, Mail, MessageCircle, MonitorSmartphone, Puzzle, Rss, Smartphone, Sparkles, Upload, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { api, refreshAll } from '@/components/api';
import { CodeBox as Code, useToast } from '@/components/ui';

type Me = {
  publicUrl: string;
  notion: { library: string };
  apiKeys: { name: string; key: string }[];
  cron: boolean;
  telegram: { configured: boolean; bot?: string | null };
  email: { configured: boolean; address?: string | null };
  ai: { enabled: boolean; paused: string | null; models: Record<string, string> };
  storage: boolean;
  backup: string | null;
};

const SHORTCUTS = [
  { file: 'Save to Trove.shortcut', name: 'Save to Trove', what: 'Share sheet in every app: links, pages, text, photos, PDFs and files. Saves instantly.' },
  { file: 'Save to Trove with Details.shortcut', name: 'Save to Trove with Details', what: 'Pick a collection, add tags and a note before saving.' },
  { file: 'Trove Quick Save.shortcut', name: 'Trove Quick Save', what: 'Saves whatever is on the clipboard. Put it on the Action Button, Back Tap, Control Center or a Mac keyboard shortcut.' },
  { file: 'Trove Note.shortcut', name: 'Trove Note', what: 'Dictate or type a thought. Works with Siri and on Apple Watch.' },
];

// ---------- import parsers ----------

type Row = { url: string; title?: string; collection?: string; tags?: string[]; note?: string; source?: string };

function parseNetscape(html: string): Row[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: Row[] = [];
  const skip = /^(bookmarks bar|bookmarks toolbar|barra de marcadores|favorites bar|other bookmarks|otros marcadores|mobile bookmarks|bookmarks menu)$/i;
  const walk = (dl: Element, path: string[]) => {
    for (const dt of Array.from(dl.children)) {
      if (dt.tagName !== 'DT') continue;
      const a = dt.querySelector(':scope > a');
      const h3 = dt.querySelector(':scope > h3');
      if (a) {
        const url = a.getAttribute('href') || '';
        if (/^https?:/.test(url)) out.push({ url, title: a.textContent?.trim(), collection: ['Browser bookmarks', ...path].join('/'), tags: (a.getAttribute('tags') || '').split(',').map((s) => s.trim()).filter(Boolean), source: 'Browser bookmarks' });
      } else if (h3) {
        const sub = dt.querySelector(':scope > dl');
        const name = h3.textContent?.trim() || '';
        if (sub) walk(sub, skip.test(name) ? path : [...path, name]);
      }
    }
  };
  const root = doc.querySelector('dl');
  if (root) walk(root, []);
  return out;
}

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      cur.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      cur.push(cell);
      rows.push(cur);
      cur = [];
      cell = '';
    } else cell += c;
  }
  if (cell || cur.length) rows.push([...cur, cell]);
  const [head, ...body] = rows.filter((r) => r.some(Boolean));
  const idx = (names: string[]) => head.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const u = idx(['url', 'link', 'href']);
  const t = idx(['title', 'name']);
  const f = idx(['folder', 'collection']);
  const g = idx(['tags']);
  const n = idx(['note', 'notes', 'description', 'excerpt']);
  return body
    .map((r) => ({ url: r[u], title: r[t], collection: r[f] || undefined, tags: (r[g] || '').split(/[,|]/).map((s) => s.trim()).filter(Boolean), note: r[n] || undefined }))
    .filter((r) => /^https?:/.test(r.url || ''));
}

function parseFile(name: string, text: string): Row[] {
  if (/\.html?$/i.test(name) || /<!DOCTYPE NETSCAPE/i.test(text)) return parseNetscape(text);
  if (/\.csv$/i.test(name)) return parseCsv(text);
  if (/\.json$/i.test(name)) {
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : j.items || [];
    return list.map((x: any) => ({ url: x.url || x.link, title: x.title, collection: x.collection || x.folder, tags: x.tags, note: x.note })).filter((r: Row) => /^https?:/.test(r.url || ''));
  }
  return (text.match(/https?:\/\/[^\s<>"']+/g) || []).map((url) => ({ url }));
}

// ---------- page ----------

export default function SettingsView() {
  const { data: me } = useSWR<Me>('/api/me', (u: string) => api(u));
  const toast = useToast();
  const [reveal, setReveal] = useState<string | null>(null);
  const [imp, setImp] = useState<{ total: number; done: number; saved: number; errors: number; running: boolean } | null>(null);
  const [quick, setQuick] = useState(true);
  const [health, setHealth] = useState<string>('');
  const [backfill, setBackfill] = useState<{ done: number; running: boolean; note?: string } | null>(null);
  const [tgStatus, setTgStatus] = useState<string>('');

  const runBackfill = async () => {
    setBackfill({ done: 0, running: true });
    let done = 0;
    for (let i = 0; i < 200; i++) {
      try {
        const r = await api<{ done: number; remaining: boolean; errors: string[] }>('/api/enrich', { method: 'POST', json: { pending: true, limit: 12 } });
        done += r.done;
        setBackfill({ done, running: true });
        if (!r.remaining || (!r.done && r.errors.length)) {
          setBackfill({ done, running: false, note: !r.done && r.errors[0] ? r.errors[0] : undefined });
          break;
        }
      } catch (e: any) {
        setBackfill({ done, running: false, note: e.message });
        break;
      }
    }
    refreshAll();
  };
  const bookmarklet = useRef<HTMLAnchorElement>(null);
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(location.origin), []);
  const base = me?.publicUrl || origin;
  const mask = (k?: string) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : '');

  useEffect(() => {
    // React blocks javascript: URLs in JSX, so set the bookmarklet's href directly.
    const code = `javascript:(()=>{const s=getSelection().toString();open('${base}/save?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)+(s?'&highlight='+encodeURIComponent(s):'')+'&source=Bookmarklet','trove','width=460,height=600')})()`;
    bookmarklet.current?.setAttribute('href', code);
  }, [base]);

  const runImport = async (file: File) => {
    const rows = parseFile(file.name, await file.text());
    if (!rows.length) return toast.push({ text: 'No links found in that file' });
    setImp({ total: rows.length, done: 0, saved: 0, errors: 0, running: true });
    for (let i = 0; i < rows.length; i += 10) {
      const batch = rows.slice(i, i + 10).map((r) => ({ source: 'Import', ...r, archive: quick ? false : undefined }));
      try {
        const r = await api<{ results: any[] }>('/api/items', { method: 'POST', json: { items: batch } });
        const saved = r.results.filter((x) => x.created).length;
        const errors = r.results.filter((x) => x.error).length;
        setImp((s) => s && { ...s, done: s.done + batch.length, saved: s.saved + saved, errors: s.errors + errors });
      } catch {
        setImp((s) => s && { ...s, done: s.done + batch.length, errors: s.errors + batch.length });
      }
    }
    setImp((s) => s && { ...s, running: false });
    refreshAll();
  };

  const mcpUrl = `${base}/api/mcp`;
  const shownKey = '<api key>';

  return (
    <div className="settings">
      <div className="settings-nav">
        <a className="btn ghost" href="/">
          <ArrowLeft size={16} /> Library
        </a>
        <span className="spacer" />
        <button className="btn ghost" onClick={async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login'; }}>
          <LogOut size={15} /> Sign out
        </button>
      </div>
      <div className="settings-head">
        <h1>Settings</h1>
        <p>Save from every device and tool. Everything lands in your Notion databases.</p>
      </div>

      <section>
        <h2>Save from anywhere</h2>
        <div className="cards-2">
          <div className="mini-card">
            <h3><MessageCircle size={16} /> Telegram</h3>
            <p>Send or forward anything to your bot: links, text, photos, videos, voice notes, files. Use <code>#tags</code>, <code>@Collection</code> and <code>!fav</code>; tap the buttons to file it. On iPhone, iPad and Mac, Share → Telegram → Trove works from every app.</p>
            {me?.telegram.configured ? (
              <div className="row-actions-inline">
                {me.telegram.bot && <a className="btn primary" href={`https://t.me/${me.telegram.bot}`} target="_blank" rel="noreferrer"><MessageCircle size={15} /> Open @{me.telegram.bot}</a>}
                <button
                  className="btn"
                  onClick={async () => {
                    setTgStatus('Checking…');
                    try {
                      const r = await api<{ webhook: string | null; lastError: string | null; inline: boolean; guest: boolean }>('/api/telegram/setup', { method: 'POST' });
                      setTgStatus(r.lastError ? `Webhook error: ${r.lastError}` : `Connected${r.inline ? ' · inline search on' : ''}${r.guest ? ' · works in any chat' : ''}`);
                    } catch (e: any) {
                      setTgStatus(`Couldn’t connect: ${e.message}`);
                    }
                  }}
                >
                  <Wrench size={15} /> Reconnect
                </button>
                <span className="muted" role="status">{tgStatus}</span>
              </div>
            ) : (
              <p className="field-hint">Set <code>TELEGRAM_BOT_TOKEN</code>, <code>TELEGRAM_WEBHOOK_SECRET</code> and <code>TELEGRAM_ALLOWED_USERS</code>, then press Reconnect.</p>
            )}
          </div>
          <div className="mini-card">
            <h3><Mail size={16} /> Email</h3>
            {me?.email.configured && me.email.address ? (
              <>
                <p>Email or forward to your Trove address: links are saved as links, newsletters as articles, attachments as files. Put <code>#tags</code> or <code>@Collection</code> in the subject.</p>
                <div className="row-actions-inline">
                  <code className="mono pill">{me.email.address}</code>
                  <button className="icon-btn sm" aria-label="Copy email address" onClick={() => { navigator.clipboard.writeText(me.email.address!); toast.push({ text: 'Address copied' }); }}><Copy size={15} /></button>
                </div>
              </>
            ) : (
              <p>Forward newsletters and links to a private address. Needs a Cloudflare Email Routing rule pointing at the trove-email worker (see README).</p>
            )}
          </div>
          <div className="mini-card wide">
            <h3><Smartphone size={16} /> iPhone, iPad and Mac shortcuts</h3>
            <p>Install on any device; they sync through iCloud. Each asks for an API key once.</p>
            <div className="shortcut-list">
              {SHORTCUTS.map((sc) => (
                <a key={sc.file} className="shortcut-row" href={`/shortcuts/${encodeURIComponent(sc.file)}`}>
                  <Download size={15} />
                  <span><strong>{sc.name}</strong><span className="sub">{sc.what}</span></span>
                </a>
              ))}
            </div>
            <p className="field-hint">Action Button: Settings → Action Button → Shortcut → Trove Quick Save. Back Tap: Settings → Accessibility → Touch → Back Tap. Mac: Shortcuts → Trove Quick Save → ⓘ → Add Keyboard Shortcut.</p>
          </div>
          <div className="mini-card">
            <h3><Puzzle size={16} /> Browser extension</h3>
            <p>Brave, Chrome, Edge and Arc. Save the page you’re on (logged-in pages are archived too), links, images and selections, and keep browser bookmarks, X bookmarks and Pinterest in sync.</p>
            <a className="btn" href="https://github.com/medpar/trove/releases/latest" target="_blank" rel="noreferrer"><Download size={15} /> Download</a>
          </div>
          <div className="mini-card">
            <h3><Command size={16} /> Raycast</h3>
            <p>Save the front tab or the clipboard with a hotkey, search by meaning with previews, and ask your library from anywhere on your Mac.</p>
            <Code>{`cd raycast && npm install && npm run dev`}</Code>
          </div>
          <div className="mini-card">
            <h3><Rss size={16} /> Feeds and newsletters</h3>
            <p>Follow blogs, Substacks and YouTube channels. Posts wait in Feeds until you save them, or auto-save into a collection.</p>
            <a className="btn" href="/?s=feeds"><Rss size={15} /> Open Feeds</a>
          </div>
          <div className="mini-card">
            <h3><MonitorSmartphone size={16} /> Install the app</h3>
            <p>Install Trove from your browser menu (Install, Add to Dock, or Add to Home Screen). On Android, Windows and ChromeOS it then appears in the system share sheet.</p>
          </div>
          <div className="mini-card">
            <h3><Link2 size={16} /> Bookmarklet</h3>
            <p>Works in any browser. Drag the button to your bookmarks bar. Selected text is saved as a highlight.</p>
            <a ref={bookmarklet} className="btn primary" onClick={(e) => e.preventDefault()}>
              Save to Trove
            </a>
          </div>
        </div>
      </section>

      <section>
        <h2>AI and web archive</h2>
        <p>New saves are filed into your collections and tags, get a one-line summary and are indexed for search by meaning. Images and PDFs are read with OCR so their text is searchable. Every web page gets a full snapshot in your Notion and a Wayback Machine copy.</p>
        <div className="status-list">
          <div className="status-row">
            <Sparkles size={16} />
            <span><strong>AI</strong><span className="sub">{!me ? '…' : !me.ai.enabled ? 'Turned off (TROVE_AI=off)' : me.ai.paused ? `Paused: ${me.ai.paused}` : `On · ${me.ai.models.text}, OCR ${me.ai.models.vision}`}</span></span>
          </div>
          <div className="status-row">
            <Landmark size={16} />
            <span><strong>Web archive</strong><span className="sub">Page snapshots in Notion, plus the Wayback Machine</span></span>
          </div>
        </div>
        <div className="row-actions-inline">
          <button className="btn" onClick={runBackfill} disabled={backfill?.running}>
            {backfill?.running ? <span className="spinner" /> : <Sparkles size={15} />} Process the rest of the library
          </button>
          <span className="muted num" role="status">{backfill ? `${backfill.done.toLocaleString()} items processed${backfill.running ? '…' : backfill.note ? ` · ${backfill.note}` : ' · Done'}` : 'Summaries, OCR, search index and archive for items saved before, in batches. A daily job does this too.'}</span>
        </div>
      </section>

      <section>
        <h2>API keys</h2>
        <p>Use a key for the CLI, scripts, the Shortcut, the extension and AI agents. Each key’s name is recorded as Via on what it saves. Keys are managed in the <code>TROVE_API_KEYS</code> environment variable.</p>
        <div className="key-list">
          {me?.apiKeys.map((k) => (
            <div key={k.name} className="key-row">
              <strong><KeyRound size={14} style={{ display: 'inline', marginInlineEnd: 8, color: 'var(--text-3)', verticalAlign: '-2px' }} />{k.name}</strong>
              <code className="mono">{reveal === k.name ? k.key : mask(k.key)}</code>
              <button className="icon-btn sm" aria-label={reveal === k.name ? `Hide ${k.name} key` : `Show ${k.name} key`} onClick={() => setReveal(reveal === k.name ? null : k.name)}>{reveal === k.name ? <EyeOff size={15} /> : <Eye size={15} />}</button>
              <button className="icon-btn sm" aria-label={`Copy ${k.name} key`} onClick={() => { navigator.clipboard.writeText(k.key); toast.push({ text: `${k.name} key copied` }); }}><Copy size={15} /></button>
            </div>
          ))}
          {!me && <div className="skeleton" style={{ height: 44, borderRadius: 0 }} />}
        </div>
      </section>

      <section>
        <h2>CLI and API for agents</h2>
        <p>Any agent or script that can run a command or make an HTTP request can save to Trove and search it, including images, videos, audio and documents it uploads. Nothing agent-specific to configure: give it the CLI or the API and a key.</p>
        <div>
          <span className="field-label">CLI (Node 20 or later)</span>
          <Code>{`npm install -g github:medpar/trove\ntrove login --url ${base} --key ${shownKey}\n\ntrove save https://example.com -t ai,reading -n "why it matters"\ntrove upload ./screenshot.png ./demo.mp4 -c "Design" -t ui\ntrove search "#ai type:article" --json\ntrove get <id> --content`}</Code>
          <p className="field-hint">Every command takes <code>--json</code>. Run <code>trove --help</code> for the full list. Agents can also read the <a className="inline-link" href="https://github.com/medpar/trove/tree/main/skills/trove" target="_blank" rel="noreferrer">skill file</a>.</p>
        </div>
        <div>
          <span className="field-label">REST</span>
          <Code>{`curl -X POST ${base}/api/items \\\n  -H "Authorization: Bearer ${shownKey}" \\\n  -H "content-type: application/json" \\\n  -d '{"url":"https://example.com","tags":["ai"],"note":"why it matters"}'\n\ncurl -X POST ${base}/api/files \\\n  -H "Authorization: Bearer ${shownKey}" \\\n  -F file=@photo.jpg -F tags=travel -F collection=Photos`}</Code>
          <p className="field-hint">Files up to 4 MB go in one request; bigger ones (up to 1 GB) get an upload URL from <code>/api/files/uploads</code>. Reference: <a className="inline-link" href="/llms.txt">llms.txt</a> and <a className="inline-link" href="/openapi.json">openapi.json</a>.</p>
        </div>
        <div>
          <span className="field-label">MCP (for clients that prefer it)</span>
          <Code>{`URL     ${mcpUrl}\nHeader  Authorization: Bearer ${shownKey}`}</Code>
        </div>
      </section>

      <section>
        <h2>Agent</h2>
        <p>The built-in agent searches, tags, sorts and tidies your library. It runs on your computer with your Claude Pro or Max, or ChatGPT subscription through Claude Code or Codex, so it needs no API keys. Open it from the Agent button in the library.</p>
        <Code>{`claude auth login        # or: codex login\ntrove agent install      # starts the agent at login (macOS)\ntrove agent "tag everything untagged"   # or use it from the terminal`}</Code>
      </section>

      <section>
        <h2>Import</h2>
        <p>Bring in browser bookmarks (HTML export from Brave, Chrome, Safari or Firefox), a Raindrop or Pocket CSV, a Trove JSON export, or any text file with links. Browser bookmarks go under the Browser bookmarks collection with their folders inside it, other folders become collections, and duplicates are skipped.</p>
        <label className="check-row">
          <input type="checkbox" checked={quick} onChange={(e) => setQuick(e.target.checked)} />
          <span>Quick import: metadata only, much faster for large files</span>
        </label>
        <div>
          <label className="btn">
            <Upload size={15} /> Choose a file
            <input type="file" accept=".html,.htm,.csv,.json,.txt" hidden onChange={(e) => e.target.files?.[0] && runImport(e.target.files[0])} />
          </label>
        </div>
        {imp && (
          <div role="status">
            <div className="progress"><div style={{ width: `${(imp.done / imp.total) * 100}%` }} /></div>
            <p className="field-hint num">
              {imp.done.toLocaleString()} of {imp.total.toLocaleString()} processed · {imp.saved.toLocaleString()} new · {imp.errors.toLocaleString()} failed{imp.running ? '' : ' · Done'}
            </p>
          </div>
        )}
      </section>

      <section>
        <h2>Export</h2>
        <p>Your data already lives in Notion. Download a copy any time.</p>
        <div className="row-actions-inline">
          {(['json', 'csv', 'html', 'txt'] as const).map((f) => (
            <a key={f} className="btn" href={`/api/export?format=${f}`}><Download size={15} /> {f.toUpperCase()}</a>
          ))}
        </div>
      </section>

      {me?.backup && (
        <section>
          <h2>Backup</h2>
          <p>Every night your whole library is exported as Markdown (one file per item, with frontmatter) and JSON to a private GitHub repository.</p>
          <div className="row-actions-inline">
            <a className="btn" href={`https://github.com/${me.backup}`} target="_blank" rel="noreferrer"><ExternalLink size={15} /> {me.backup}</a>
          </div>
        </section>
      )}

      <section>
        <h2>Library health</h2>
        <p>A daily job checks saved links and flags broken ones. Their archived copies stay readable in Trove and Notion.</p>
        <div className="row-actions-inline">
          <button
            className="btn"
            onClick={async () => {
              setHealth('Checking…');
              try {
                const r = await api<{ checked: number; broken: number }>('/api/cron/links?limit=60');
                setHealth(`Checked ${r.checked} links, ${r.broken} broken`);
                refreshAll();
              } catch (e: any) {
                setHealth(`Couldn’t check links: ${e.message}`);
              }
            }}
          >
            <Wrench size={15} /> Check links now
          </button>
          <span className="muted" role="status">{health}</span>
        </div>
      </section>

      <section>
        <h2>Notion</h2>
        <div className="row-actions-inline">
          {me?.notion.library && <a className="btn" href={me.notion.library} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Open the Trove database</a>}
        </div>
      </section>
    </div>
  );
}
