'use client';
import {
  ArrowLeft, ArrowUpRight, Bookmark, Code2, Command, Copy, Database, Download, Eye, EyeOff, HardDrive, Headphones, Inbox, KeyRound, Landmark, Link2, LogOut, Mail,
  MessageCircle, MonitorSmartphone, Moon, Puzzle, RefreshCw, Rss, Sparkles, Star, Sun, Upload, UserRound, Wrench,
} from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import useSWR from 'swr';
import { api, refreshAll } from '@/components/api';
import { ShowsSettings } from '@/components/media-settings';
import { More, Panel, Row, Section, Segmented, Status, Switch, ago, type Kind } from '@/components/settings-ui';
import { CodeBox, useToast } from '@/components/ui';
import { parseFile } from './import-parse';

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
type Note = { kind?: Kind; text: string } | null;

const SECTIONS = [
  { id: 'capture', label: 'Ways to save', icon: Inbox },
  { id: 'shows', label: 'Shows', icon: Headphones },
  { id: 'sources', label: 'Sources', icon: Rss },
  { id: 'ai', label: 'AI & archive', icon: Sparkles },
  { id: 'developers', label: 'Developers', icon: Code2 },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'account', label: 'Account', icon: UserRound },
];

const SHORTCUTS = [
  { file: 'Save to Trove.shortcut', name: 'Save to Trove', what: 'In the share sheet of every app: links, pages, text, photos, PDFs and files. Saves instantly.' },
  { file: 'Save to Trove with Details.shortcut', name: 'Save to Trove with Details', what: 'Pick a collection, add tags and a note before saving.' },
  { file: 'Trove Quick Save.shortcut', name: 'Trove Quick Save', what: 'Saves whatever is on the clipboard. Made for the Action Button, Back Tap, Control Center or a keyboard shortcut.' },
  { file: 'Trove Note.shortcut', name: 'Trove Note', what: 'Dictate or type a thought. Works with Siri and on Apple Watch.' },
];

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- page ----------

export default function SettingsView() {
  const { data: me } = useSWR<Me>('/api/me', (u: string) => api(u));
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(location.origin), []);
  const base = me?.publicUrl || origin;
  const { active, go, navRef } = useSectionNav();

  return (
    <div className="settings">
      <header className="set-head">
        <a className="btn ghost" href="/">
          <ArrowLeft size={16} /> Library
        </a>
        <h1>Settings</h1>
      </header>
      <div className="set-shell">
        <aside className="set-side">
          <nav className="set-nav" aria-label="Settings sections" ref={navRef}>
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <a key={id} href={`#${id}`} data-id={id} aria-current={active === id ? 'true' : undefined} onClick={(e) => go(e, id)}>
                <Icon size={16} aria-hidden="true" /> {label}
              </a>
            ))}
          </nav>
        </aside>
        <main className="set-main">
          <CaptureSection me={me} base={base} />
          <ShowsSettings base={base} />
          <SourcesSection />
          <AiSection me={me} />
          <DevelopersSection me={me} base={base} />
          <DataSection me={me} />
          <AccountSection me={me} />
        </main>
      </div>
    </div>
  );
}

/** Highlights the section you're reading and scrolls to one on click (the side list on desktop, a scrolling strip on phones). */
function useSectionNav() {
  const [active, setActive] = useState(SECTIONS[0].id);
  const navRef = useRef<HTMLElement>(null);
  const clicked = useRef(0);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      if (Date.now() - clicked.current < 900) return;
      const doc = document.documentElement;
      let current = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= 160) current = s.id;
      }
      if (innerHeight + scrollY >= doc.scrollHeight - 4 && scrollY > 0) current = SECTIONS[SECTIONS.length - 1].id;
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // A deep link (/settings#shows) lands before the data has loaded: land on it again once the page has settled.
    const id = location.hash.slice(1);
    const settle = id ? setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 350) : undefined;
    update();
    addEventListener('scroll', schedule, { passive: true });
    addEventListener('resize', schedule);
    return () => {
      removeEventListener('scroll', schedule);
      removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
      clearTimeout(settle);
    };
  }, []);

  // Keep the current item in view in the phone strip.
  useEffect(() => {
    const nav = navRef.current;
    const a = nav?.querySelector<HTMLElement>(`[data-id="${active}"]`);
    if (!nav || !a || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollTo({ left: a.offsetLeft - (nav.clientWidth - a.offsetWidth) / 2, behavior: reduceMotion() ? 'auto' : 'smooth' });
  }, [active]);

  const go = (e: MouseEvent, id: string) => {
    e.preventDefault();
    clicked.current = Date.now();
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
    history.replaceState(null, '', `#${id}`);
  };

  return { active, go, navRef };
}

// ---------- ways to save ----------

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

function useInstall() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    setInstalled(matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true);
    const offer = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPrompt);
    };
    const done = () => {
      setInstalled(true);
      setPrompt(null);
    };
    addEventListener('beforeinstallprompt', offer);
    addEventListener('appinstalled', done);
    return () => {
      removeEventListener('beforeinstallprompt', offer);
      removeEventListener('appinstalled', done);
    };
  }, []);
  const install = async () => {
    if (!prompt) return;
    await prompt.prompt();
    if ((await prompt.userChoice).outcome === 'accepted') setInstalled(true);
    setPrompt(null);
  };
  return { canInstall: !!prompt, installed, install };
}

function CaptureSection({ me, base }: { me?: Me; base: string }) {
  const toast = useToast();
  const install = useInstall();
  const [tg, setTg] = useState<Note>(null);
  const [raycast, setRaycast] = useState(false);
  const bookmarklet = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    // React blocks javascript: URLs in JSX, so set the bookmarklet's href directly.
    const code = `javascript:(()=>{const s=getSelection().toString();open('${base}/save?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)+(s?'&highlight='+encodeURIComponent(s):'')+'&source=Bookmarklet','trove','width=460,height=600')})()`;
    bookmarklet.current?.setAttribute('href', code);
  }, [base]);

  const reconnectTelegram = async () => {
    setTg({ kind: 'busy', text: 'Checking…' });
    try {
      const r = await api<{ webhook: string | null; lastError: string | null; inline: boolean; guest: boolean }>('/api/telegram/setup', { method: 'POST' });
      setTg(r.lastError ? { kind: 'err', text: `Webhook error: ${r.lastError}` } : { kind: 'ok', text: `Connected${r.inline ? ' · inline search on' : ''}${r.guest ? ' · works in any chat' : ''}` });
    } catch (e: any) {
      setTg({ kind: 'err', text: `Couldn’t connect: ${e.message}` });
    }
  };

  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text);
    toast.push({ text: `${what} copied` });
  };

  return (
    <Section id="capture" title="Ways to save" desc="Save from every device and app. Everything lands in your Notion.">
      <Panel title="Browser and computer">
        <Row
          icon={<Puzzle size={17} />}
          title="Browser extension"
          desc="Brave, Chrome, Edge and Arc. Saves the page you’re on (signed-in pages too), links, images and selections, keeps bookmarks, X bookmarks and Pinterest in sync, and tracks YouTube and Spotify."
        >
          <a className="btn sm" href="https://github.com/medpar/trove/releases/latest" target="_blank" rel="noreferrer">
            <Download size={14} /> Download
          </a>
        </Row>
        <Row icon={<Link2 size={17} />} title="Bookmarklet" desc="For any browser. Drag the button to your bookmarks bar. Text you’ve selected is saved as a highlight.">
          <a
            ref={bookmarklet}
            className="btn sm set-grab"
            title="Drag to your bookmarks bar"
            onClick={(e) => {
              e.preventDefault();
              toast.push({ text: 'Drag the button to your bookmarks bar' });
            }}
          >
            <Bookmark size={14} /> Save to Trove
          </a>
        </Row>
        <Row
          icon={<MonitorSmartphone size={17} />}
          title="Install the app"
          desc={install.installed ? 'Trove runs in its own window on this device.' : 'Its own window, and on Android, Windows and ChromeOS a place in the system share sheet. Or use your browser’s menu: Install, Add to Dock, or Add to Home Screen.'}
          status={install.installed ? <Status kind="ok">Installed</Status> : undefined}
        >
          {install.canInstall && (
            <button className="btn sm" onClick={install.install}>
              <Download size={14} /> Install
            </button>
          )}
        </Row>
        <Row icon={<Command size={17} />} title="Raycast" desc="Save the front tab or the clipboard with a hotkey, search by meaning, and ask your library from anywhere on your Mac.">
          <button className="btn sm" aria-expanded={raycast} aria-controls="raycast-setup" onClick={() => setRaycast(!raycast)}>
            {raycast ? 'Hide' : 'Set up'}
          </button>
        </Row>
        {raycast && (
          <div className="set-block" id="raycast-setup">
            <CodeBox>{`cd raycast && npm install && npm run dev`}</CodeBox>
            <p className="set-hint">From your copy of the Trove repository. Raycast keeps the extension after the first run.</p>
          </div>
        )}
      </Panel>

      <Panel title="iPhone, iPad and Mac" desc="Apple Shortcuts. Install them on any device and they sync through iCloud. Each asks for an API key once.">
        {SHORTCUTS.map((sc) => (
          <Row key={sc.file} title={sc.name} desc={sc.what}>
            <a className="btn sm" href={`/shortcuts/${encodeURIComponent(sc.file)}`}>
              <Download size={14} /> Get
            </a>
          </Row>
        ))}
        <More summary="Put Quick Save on a button">
          <dl className="set-dl">
            <dt>Action Button</dt>
            <dd>Settings → Action Button → Shortcut → Trove Quick Save</dd>
            <dt>Back Tap</dt>
            <dd>Settings → Accessibility → Touch → Back Tap</dd>
            <dt>Mac</dt>
            <dd>Shortcuts → Trove Quick Save → ⓘ → Add Keyboard Shortcut</dd>
          </dl>
        </More>
      </Panel>

      <Panel title="Messages">
        <Row
          icon={<MessageCircle size={17} />}
          title="Telegram"
          desc={
            me?.telegram.configured ? (
              <>
                Send or forward anything to your bot: links, text, photos, videos, voice notes and files. Use <code>#tags</code>, <code>@Collection</code> and <code>!fav</code>. On Apple devices, Share → Telegram → Trove works
                from every app.
              </>
            ) : (
              <>
                Set <code>TELEGRAM_BOT_TOKEN</code>, <code>TELEGRAM_WEBHOOK_SECRET</code> and <code>TELEGRAM_ALLOWED_USERS</code> to save by messaging your own bot.
              </>
            )
          }
          status={
            tg ? (
              <Status live kind={tg.kind}>
                {tg.text}
              </Status>
            ) : me && !me.telegram.configured ? (
              <Status kind="off">Not set up</Status>
            ) : undefined
          }
        >
          {me?.telegram.configured && (
            <>
              <button className="btn ghost sm" onClick={reconnectTelegram} disabled={tg?.kind === 'busy'}>
                <Wrench size={14} /> Reconnect
              </button>
              {me.telegram.bot && (
                <a className="btn sm" href={`https://t.me/${me.telegram.bot}`} target="_blank" rel="noreferrer">
                  Open @{me.telegram.bot} <ArrowUpRight size={14} />
                </a>
              )}
            </>
          )}
        </Row>
        <Row
          icon={<Mail size={17} />}
          title="Email"
          desc={
            me?.email.configured && me.email.address ? (
              <>
                Email or forward to your address: links are saved as links, newsletters as articles, attachments as files. Put <code>#tags</code> or <code>@Collection</code> in the subject.
              </>
            ) : (
              'Forward newsletters and links to a private address. Needs a Cloudflare Email Routing rule pointing at the trove-email worker (see the README).'
            )
          }
          status={me?.email.address ? <code className="set-chip">{me.email.address}</code> : me ? <Status kind="off">Not set up</Status> : undefined}
        >
          {me?.email.address && (
            <button className="btn sm" onClick={() => copy(me.email.address!, 'Address')}>
              <Copy size={14} /> Copy
            </button>
          )}
        </Row>
      </Panel>
    </Section>
  );
}

// ---------- sources ----------

type Stars = { config: { user: string; token: boolean } | null; state: { synced: number; lastRun?: string; lastError?: string | null; backfillDone: boolean } | null };

function SourcesSection() {
  const toast = useToast();
  const stars = useSWR<Stars>('/api/github', (u: string) => api(u));
  const [busy, setBusy] = useState(false);
  const config = stars.data?.config;
  const state = stars.data?.state;

  const sync = async () => {
    setBusy(true);
    try {
      let total = 0;
      for (let i = 0; i < 10; i++) {
        const r = await api<{ saved: number; merged: number; backfillDone: boolean; error: string | null }>('/api/github', { method: 'POST' });
        total += r.saved;
        if (r.error) {
          toast.push({ text: `GitHub sync stopped: ${r.error}` });
          break;
        }
        if (r.backfillDone) {
          toast.push({ text: total ? `Saved ${total} starred repo${total === 1 ? '' : 's'}` : 'Your GitHub stars are up to date' });
          break;
        }
      }
    } catch (e: any) {
      toast.push({ text: `GitHub sync failed: ${e.message}` });
    } finally {
      setBusy(false);
      stars.mutate();
      refreshAll();
    }
  };

  const starsStatus = !stars.data ? undefined : !config ? (
    <Status kind="off">Not set up</Status>
  ) : state?.lastError ? (
    <Status kind="err">Last sync: {state.lastError}</Status>
  ) : state?.lastRun ? (
    <Status kind="ok">
      {state.synced.toLocaleString()} repos saved · synced {ago(state.lastRun)}
      {state.backfillDone ? '' : ' · first sync in progress'}
    </Status>
  ) : (
    <Status kind="off">Not synced yet</Status>
  );

  return (
    <Section id="sources" title="Sources" desc="Places Trove keeps an eye on, so what you star, follow or bookmark there ends up in your library.">
      <Panel>
        <Row
          icon={<Star size={17} />}
          title="GitHub stars"
          desc={
            config ? (
              <>
                Every repo <strong>@{config.user}</strong> stars is saved to the GitHub stars collection with its README, twice a day.
              </>
            ) : (
              <>
                Set <code>GITHUB_STARS_USER</code> to your GitHub username (and optionally <code>GITHUB_TOKEN</code>) to save every repo you star.
              </>
            )
          }
          status={starsStatus}
        >
          {config && (
            <>
              <a className="btn ghost sm" href={`/?s=${encodeURIComponent('collection:GitHub stars')}`}>
                Open
              </a>
              <button className="btn sm" onClick={sync} disabled={busy}>
                {busy ? <span className="spinner" /> : <RefreshCw size={14} />} Sync now
              </button>
            </>
          )}
        </Row>
        <Row icon={<Rss size={17} />} title="Feeds and newsletters" desc="Follow blogs, Substacks and YouTube channels. New posts wait in Feeds until you save them, or go straight into a collection.">
          <a className="btn sm" href="/?s=feeds">
            Open Feeds
          </a>
        </Row>
        <Row icon={<Bookmark size={17} />} title="X bookmarks and Pinterest" desc="The browser extension keeps them in sync, X bookmarks with their threads and media. Set them up in the extension’s settings." />
      </Panel>
    </Section>
  );
}

// ---------- AI ----------

function AiSection({ me }: { me?: Me }) {
  const [run, setRun] = useState<{ done: number; running: boolean; note?: string } | null>(null);

  const catchUp = async () => {
    setRun({ done: 0, running: true });
    let done = 0;
    for (let i = 0; i < 200; i++) {
      try {
        const r = await api<{ done: number; remaining: boolean; paused?: string | null; errors: string[] }>('/api/enrich', { method: 'POST', json: { pending: true, limit: 12 } });
        done += r.done;
        setRun({ done, running: true });
        if (!r.remaining || r.paused || (!r.done && r.errors.length)) {
          setRun({ done, running: false, note: r.paused || (!r.done && r.errors[0]) || undefined });
          break;
        }
      } catch (e: any) {
        setRun({ done, running: false, note: e.message });
        break;
      }
    }
    refreshAll();
  };

  const ai = me?.ai;
  const aiStatus = !ai ? (
    <Status>Checking…</Status>
  ) : !ai.enabled ? (
    <Status kind="off">Turned off (TROVE_AI=off)</Status>
  ) : ai.paused ? (
    <Status kind="warn">Paused: {ai.paused}</Status>
  ) : (
    <Status kind="ok">
      On · {ai.models.text} · OCR with {ai.models.vision}
    </Status>
  );

  return (
    <Section
      id="ai"
      title="AI and web archive"
      desc="New saves are filed into your collections and tags, get a one-line summary and are indexed for search by meaning. Images and PDFs are read with OCR, and every web page gets a full snapshot."
    >
      <Panel>
        <Row icon={<Sparkles size={17} />} title="AI" status={aiStatus} />
        <Row icon={<Landmark size={17} />} title="Web archive" status={<Status kind="ok">Page snapshots in Notion, plus a Wayback Machine copy</Status>} />
        <Row
          icon={<RefreshCw size={17} />}
          title="Catch up older saves"
          desc="Summaries, OCR, the search index and archives for items saved before, in batches. An hourly job does this too, within the free daily AI allowance."
          status={
            run ? (
              <Status live kind={run.running ? 'busy' : run.note ? 'warn' : 'ok'}>
                {run.done.toLocaleString()} items processed{run.running ? '…' : run.note ? ` · ${run.note}` : ' · done'}
              </Status>
            ) : undefined
          }
        >
          <button className="btn sm" onClick={catchUp} disabled={run?.running}>
            {run?.running ? <span className="spinner" /> : <Sparkles size={14} />} {run?.running ? 'Processing' : 'Process now'}
          </button>
        </Row>
      </Panel>
    </Section>
  );
}

// ---------- developers ----------

function DevelopersSection({ me, base }: { me?: Me; base: string }) {
  const toast = useToast();
  const [reveal, setReveal] = useState<string | null>(null);
  const [tool, setTool] = useState<'cli' | 'rest' | 'mcp'>('cli');
  const key = '<api key>';
  const mask = (k: string) => (k ? `${k.slice(0, 6)}••••••••${k.slice(-4)}` : '');

  return (
    <Section id="developers" title="Developers" desc="Any agent or script that can run a command or make an HTTP request can save to Trove and search it, including images, videos, audio and documents it uploads.">
      <Panel
        title="API keys"
        desc={
          <>
            For the CLI, scripts, Shortcuts, the extension and AI agents. Each key’s name is recorded as Via on what it saves. Managed in the <code>TROVE_API_KEYS</code> environment variable.
          </>
        }
      >
        {me ? (
          me.apiKeys.map((k) => (
            <Row key={k.name} inline icon={<KeyRound size={16} />} title={k.name} desc={<code className="set-key">{reveal === k.name ? k.key : mask(k.key)}</code>}>
              <button className="icon-btn sm" aria-label={reveal === k.name ? `Hide the ${k.name} key` : `Show the ${k.name} key`} aria-pressed={reveal === k.name} onClick={() => setReveal(reveal === k.name ? null : k.name)}>
                {reveal === k.name ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
              <button
                className="icon-btn sm"
                aria-label={`Copy the ${k.name} key`}
                onClick={() => {
                  navigator.clipboard.writeText(k.key);
                  toast.push({ text: `${k.name} key copied` });
                }}
              >
                <Copy size={15} />
              </button>
            </Row>
          ))
        ) : (
          <div className="set-block">
            <div className="skeleton" style={{ height: 34 }} />
            <div className="skeleton" style={{ height: 34 }} />
          </div>
        )}
      </Panel>

      <Panel title="Connect a tool" desc="Give it the CLI or the API and a key. Nothing agent-specific to configure.">
        <div className="set-block">
          <Segmented
            name="tool"
            label="How to connect"
            value={tool}
            onChange={setTool}
            options={[
              { value: 'cli', label: 'CLI' },
              { value: 'rest', label: 'REST API' },
              { value: 'mcp', label: 'MCP' },
            ]}
          />
          {tool === 'cli' && (
            <>
              <CodeBox>{`npm install -g github:medpar/trove\ntrove login --url ${base} --key ${key}\n\ntrove save https://example.com -t ai,reading -n "why it matters"\ntrove upload ./screenshot.png ./demo.mp4 -c "Design" -t ui\ntrove search "#ai type:article" --json\ntrove get <id> --content`}</CodeBox>
              <p className="set-hint">
                Node 20 or later. Every command takes <code>--json</code>; <code>trove --help</code> lists them all. Agents can also read the{' '}
                <a className="set-link" href="https://github.com/medpar/trove/tree/main/skills/trove" target="_blank" rel="noreferrer">
                  skill file
                </a>
                .
              </p>
            </>
          )}
          {tool === 'rest' && (
            <>
              <CodeBox>{`curl -X POST ${base}/api/items \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "content-type: application/json" \\\n  -d '{"url":"https://example.com","tags":["ai"],"note":"why it matters"}'\n\ncurl -X POST ${base}/api/files \\\n  -H "Authorization: Bearer ${key}" \\\n  -F file=@photo.jpg -F tags=travel -F collection=Photos`}</CodeBox>
              <p className="set-hint">
                Files up to 4 MB go in one request; bigger ones (up to 1 GB) get an upload URL from <code>/api/files/uploads</code>. Reference:{' '}
                <a className="set-link" href="/llms.txt">
                  llms.txt
                </a>{' '}
                and{' '}
                <a className="set-link" href="/openapi.json">
                  openapi.json
                </a>
                .
              </p>
            </>
          )}
          {tool === 'mcp' && (
            <>
              <CodeBox>{`URL     ${base}/api/mcp\nHeader  Authorization: Bearer ${key}`}</CodeBox>
              <p className="set-hint">For clients that prefer MCP to the CLI or the REST API.</p>
            </>
          )}
        </div>
      </Panel>

      <Panel
        title="Built-in agent"
        desc="Searches, tags, sorts and tidies your library. It runs on your computer with your Claude Pro or Max, or ChatGPT subscription through Claude Code or Codex, so it needs no API keys. Open it from the Agent button in the library."
      >
        <div className="set-block">
          <CodeBox>{`claude auth login        # or: codex login\ntrove agent install      # starts the agent at login (macOS)\ntrove agent "tag everything untagged"   # or use it from the terminal`}</CodeBox>
        </div>
      </Panel>
    </Section>
  );
}

// ---------- data ----------

function DataSection({ me }: { me?: Me }) {
  const toast = useToast();
  const [quick, setQuick] = useState(true);
  const [over, setOver] = useState(false);
  const [imp, setImp] = useState<{ name: string; total: number; done: number; saved: number; errors: number; running: boolean } | null>(null);
  const [links, setLinks] = useState<Note>(null);

  const runImport = async (file: File) => {
    if (imp?.running) return;
    let rows;
    try {
      rows = parseFile(file.name, await file.text());
    } catch (e: any) {
      return toast.push({ text: `Couldn’t read ${file.name}: ${e.message}` });
    }
    if (!rows.length) return toast.push({ text: `No links found in ${file.name}` });
    setImp({ name: file.name, total: rows.length, done: 0, saved: 0, errors: 0, running: true });
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

  const checkLinks = async () => {
    setLinks({ kind: 'busy', text: 'Checking…' });
    try {
      const r = await api<{ checked: number; broken: number }>('/api/cron/links?limit=60');
      setLinks({ kind: r.broken ? 'warn' : 'ok', text: `Checked ${r.checked} links · ${r.broken} broken` });
      refreshAll();
    } catch (e: any) {
      setLinks({ kind: 'err', text: `Couldn’t check links: ${e.message}` });
    }
  };

  const pct = imp ? Math.round((imp.done / imp.total) * 100) : 0;

  return (
    <Section id="data" title="Data" desc="Bring your links in, take a copy out, and keep the library healthy.">
      <Panel
        title="Import"
        desc="Browser bookmarks (the HTML export from Brave, Chrome, Safari or Firefox), a Raindrop or Pocket CSV, a Trove JSON export, or any text file with links. Bookmark folders become collections under Browser bookmarks, and duplicates are skipped."
      >
        <Row title="Quick import" desc="Saves each link with its title and details only, without archiving the page. Much faster for large files.">
          <Switch checked={quick} onChange={setQuick} label="Quick import" />
        </Row>
        <div className="set-block">
          <label
            className={`set-drop${over ? ' over' : ''}${imp?.running ? ' disabled' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const f = e.dataTransfer.files[0];
              if (f) runImport(f);
            }}
          >
            <Upload size={18} aria-hidden="true" />
            <span>
              <strong>Choose a file</strong> or drop it here
            </span>
            <span className="set-hint">HTML, CSV, JSON or plain text</span>
            <input
              type="file"
              className="sr"
              accept=".html,.htm,.csv,.json,.txt"
              disabled={imp?.running}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) runImport(f);
              }}
            />
          </label>
          {imp && (
            <div className="set-import" role="status">
              <div className="set-import-line">
                <span className="set-import-name">{imp.name}</span>
                <span className="num">{imp.running ? `${pct}%` : 'Done'}</span>
              </div>
              <div className="set-progress" role="progressbar" aria-label={`Importing ${imp.name}`} aria-valuemin={0} aria-valuemax={imp.total} aria-valuenow={imp.done}>
                <div style={{ width: `${pct}%` }} />
              </div>
              <p className="set-hint num">
                {imp.done.toLocaleString()} of {imp.total.toLocaleString()} processed · {imp.saved.toLocaleString()} new · {imp.errors.toLocaleString()} failed
              </p>
            </div>
          )}
        </div>
      </Panel>

      <Panel>
        <Row icon={<Download size={17} />} title="Export" desc="Your library already lives in Notion. Download a copy any time.">
          {(['json', 'csv', 'html', 'txt'] as const).map((f) => (
            <a key={f} className="btn sm" href={`/api/export?format=${f}`} download>
              {f.toUpperCase()}
            </a>
          ))}
        </Row>
        {me?.backup && (
          <Row icon={<HardDrive size={17} />} title="Nightly backup" desc="Every night the whole library goes to a private GitHub repository as Markdown (one file per item, with frontmatter) and JSON." status={<Status kind="ok">On</Status>}>
            <a className="btn sm" href={`https://github.com/${me.backup}`} target="_blank" rel="noreferrer">
              Open repository <ArrowUpRight size={14} />
            </a>
          </Row>
        )}
        <Row
          icon={<Wrench size={17} />}
          title="Broken links"
          desc="A daily job checks saved links and flags broken ones. Their archived copies stay readable in Trove and Notion."
          status={
            links ? (
              <Status live kind={links.kind}>
                {links.text}
              </Status>
            ) : undefined
          }
        >
          <button className="btn sm" onClick={checkLinks} disabled={links?.kind === 'busy'}>
            {links?.kind === 'busy' && <span className="spinner" />} Check now
          </button>
        </Row>
      </Panel>
    </Section>
  );
}

// ---------- account ----------

function AccountSection({ me }: { me?: Me }) {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [leaving, setLeaving] = useState(false);
  useEffect(() => setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'), []);

  // Same switch as the library's theme button: flip every token at once instead of letting each transition smear the change.
  const pickTheme = (next: 'light' | 'dark') => {
    setTheme(next);
    const css = document.createElement('style');
    css.textContent = '*,*::before,*::after{transition:none!important}';
    document.head.appendChild(css);
    if (next === 'dark') document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    void document.body.offsetHeight;
    requestAnimationFrame(() => css.remove());
    try {
      localStorage.setItem('trove-theme', next);
    } catch {
      /* private mode */
    }
  };

  const signOut = async () => {
    setLeaving(true);
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = '/login';
  };

  return (
    <Section id="account" title="Account">
      <Panel>
        <Row icon={<Database size={17} />} title="Notion" desc="Your library lives in the Trove database in your Notion workspace.">
          {me?.notion.library && (
            <a className="btn sm" href={me.notion.library} target="_blank" rel="noreferrer">
              Open in Notion <ArrowUpRight size={14} />
            </a>
          )}
        </Row>
        <Row icon={theme === 'dark' ? <Moon size={17} /> : <Sun size={17} />} title="Appearance" desc="For this device.">
          <Segmented
            name="theme"
            label="Appearance"
            value={theme}
            onChange={pickTheme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Row>
        <Row icon={<LogOut size={17} />} title="Sign out" desc="Signs this browser out of Trove. API keys and connections keep working.">
          <button className="btn sm danger" onClick={signOut} disabled={leaving}>
            {leaving && <span className="spinner" />} Sign out
          </button>
        </Row>
      </Panel>
    </Section>
  );
}
