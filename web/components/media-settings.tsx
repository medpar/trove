'use client';
import { Puzzle, RefreshCw, Smartphone, Unplug, Zap } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import { api } from './api';
import { More, Panel, Row, Section, Status, ago, type Kind } from './settings-ui';
import { PlatformLogo } from './shows';
import { CodeBox, useToast } from './ui';

type Side = { connected: boolean; at: number | null; ok: boolean | null; error: string | null; needsSignIn: boolean; user?: string | null; fromEnv?: boolean };
type Connections = { spotify: Side; youtube: Side; shows: number };
type Which = 'spotify' | 'youtube';

const NAME: Record<Which, string> = { spotify: 'Spotify', youtube: 'YouTube' };

function describe(x: Side | undefined, error?: Error): { kind?: Kind; text: string } {
  if (!x) return error ? { kind: 'err', text: `Couldn’t check: ${error.message}` } : { text: 'Checking…' };
  if (!x.connected) return { kind: 'off', text: 'Not connected' };
  if (x.needsSignIn) return { kind: 'err', text: 'The sign-in expired. Connect again.' };
  if (x.error) return { kind: 'warn', text: `Last sync failed: ${x.error}` };
  const who = x.user ? ` as ${x.user}` : '';
  const when = x.at ? `synced ${ago(x.at)}` : 'first sync within the hour';
  return { kind: 'ok', text: `Connected${who} · ${when}${x.fromEnv ? ' · from an environment variable' : ''}` };
}

/** Settings → Shows: what tracks your YouTube and Spotify progress, and the sign-ins the server uses for your phone. */
export function ShowsSettings({ base }: { base: string }) {
  const toast = useToast();
  const { data: s, error, mutate } = useSWR<Connections>('/api/media/connect', (u: string) => api(u));
  const [open, setOpen] = useState<Which | null>(null);
  const [value, setValue] = useState<Record<Which, string>>({ spotify: '', youtube: '' });
  const [busy, setBusy] = useState<Which | 'sync' | null>(null);
  const [confirm, setConfirm] = useState<Which | null>(null);
  const [result, setResult] = useState<{ kind?: Kind; text: string } | null>(null);
  const [automation, setAutomation] = useState(false);
  const any = !!(s?.spotify.connected || s?.youtube.connected);

  const connect = async (which: Which) => {
    setBusy(which);
    try {
      const r = await api<{ spotify?: { name: string }; youtube?: { videos: number } }>('/api/media/connect', { method: 'POST', json: { [which]: value[which].trim() } });
      toast.push({ text: which === 'spotify' ? `Spotify connected as ${r.spotify?.name}` : `YouTube connected · ${(r.youtube?.videos ?? 0).toLocaleString()} videos in your history` });
      setValue((v) => ({ ...v, [which]: '' }));
      setOpen(null);
      mutate();
    } catch (e: any) {
      toast.push({ text: `Couldn’t connect ${NAME[which]}: ${e.message}` });
    } finally {
      setBusy(null);
    }
  };

  // Two clicks: setting YouTube up again takes a minute, so don't drop it on a stray click.
  const disconnect = async (which: Which) => {
    if (confirm !== which) {
      setConfirm(which);
      setTimeout(() => setConfirm((c) => (c === which ? null : c)), 4000);
      return;
    }
    setConfirm(null);
    try {
      await api(`/api/media/connect?which=${which}`, { method: 'DELETE' });
      toast.push({ text: `${NAME[which]} disconnected` });
    } catch (e: any) {
      toast.push({ text: `Couldn’t disconnect ${NAME[which]}: ${e.message}` });
    }
    mutate();
  };

  const syncNow = async (deep: boolean) => {
    setBusy('sync');
    setResult({ kind: 'busy', text: deep ? 'Importing older history…' : 'Syncing…' });
    try {
      const r = await api<Record<string, any>>(`/api/media/sync?wait=1${deep ? '&deep=1' : ''}`, { method: 'POST' });
      const part = (name: string, x: any) => (x ? (x.error ? `${name}: ${x.error}` : `${name}: ${x.events} change${x.events === 1 ? '' : 's'}`) : '');
      const failed = [r.spotify, r.youtube].some((x) => x?.error);
      const text = [part('Spotify', r.spotify), part('YouTube', r.youtube), r.catalog ? `refreshed ${r.catalog.show}` : '', `${r.updated || 0} episodes updated`].filter(Boolean).join(' · ');
      setResult({ kind: failed ? 'warn' : 'ok', text });
      mutate();
    } catch (e: any) {
      setResult({ kind: 'err', text: `Sync failed: ${e.message}` });
    } finally {
      setBusy(null);
    }
  };

  const service = (which: Which) => {
    const x = s?.[which];
    const st = describe(x, error);
    const healthy = !!x?.connected && !x.needsSignIn;
    const expanded = open === which;
    const id = `connect-${which}`;
    return (
      <>
        <Row icon={<PlatformLogo p={which === 'spotify' ? 'sp' : 'yt'} size={20} />} title={NAME[which]} status={<Status kind={st.kind}>{st.text}</Status>}>
          {healthy && !x!.fromEnv && !expanded && (
            <button className={`btn ghost sm${confirm === which ? ' danger' : ''}`} onClick={() => disconnect(which)}>
              <Unplug size={14} /> {confirm === which ? 'Click again to disconnect' : 'Disconnect'}
            </button>
          )}
          {x && (
            <button className={`btn sm${healthy || expanded ? '' : ' primary'}`} aria-expanded={expanded} aria-controls={id} onClick={() => setOpen(expanded ? null : which)}>
              {expanded ? 'Cancel' : healthy ? 'Reconnect' : 'Connect'}
            </button>
          )}
        </Row>
        {expanded && (
          <div className="set-connect" id={id}>
            <div className="set-callout">
              <Puzzle size={16} aria-hidden="true" />
              <p>
                <strong>Easiest: from the Trove extension.</strong>{' '}
                {which === 'spotify' ? (
                  <>In its settings, open <strong>YouTube &amp; Spotify</strong> and click <strong>Connect</strong> next to Spotify. It uses that browser’s Spotify sign-in.</>
                ) : (
                  <>In its settings, open <strong>YouTube &amp; Spotify</strong> and click <strong>Set up</strong> next to YouTube. It walks you through signing in from a private window, which keeps the sign-in working much longer.</>
                )}
              </p>
            </div>
            <More bare summary={which === 'spotify' ? 'Or paste the sp_dc cookie yourself' : 'Or paste the cookies yourself'}>
              <form
                className="set-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  connect(which);
                }}
              >
                {which === 'spotify' ? (
                  <>
                    <label className="field-label" htmlFor="sp-dc">
                      sp_dc cookie
                    </label>
                    <div className="set-inline">
                      <input id="sp-dc" className="input mono" type="password" autoComplete="off" spellCheck={false} value={value.spotify} onChange={(e) => setValue((v) => ({ ...v, spotify: e.target.value }))} />
                      <button className="btn primary" disabled={!value.spotify.trim() || busy === 'spotify'}>
                        {busy === 'spotify' && <span className="spinner" />} Connect
                      </button>
                    </div>
                    <p className="set-hint">
                      On open.spotify.com, signed in: developer tools → Application → Cookies → open.spotify.com → <code>sp_dc</code>. It works like a password for your Spotify account: Trove keeps it encrypted, and signing out of
                      Spotify everywhere ends it.
                    </p>
                  </>
                ) : (
                  <>
                    <label className="field-label" htmlFor="yt-cookies">
                      Cookies
                    </label>
                    <textarea
                      id="yt-cookies"
                      className="textarea mono"
                      rows={3}
                      spellCheck={false}
                      value={value.youtube}
                      onChange={(e) => setValue((v) => ({ ...v, youtube: e.target.value }))}
                      placeholder="# Netscape HTTP Cookie File …   or   SAPISID=…; SID=…"
                    />
                    <div className="set-inline">
                      <button className="btn primary" disabled={!value.youtube.trim() || busy === 'youtube'}>
                        {busy === 'youtube' && <span className="spinner" />} Connect
                      </button>
                    </div>
                    <p className="set-hint">From a private window signed in to youtube.com: a cookies.txt export, a <code>Cookie:</code> header or a JSON export. Then close the window, so no browser keeps using that sign-in.</p>
                  </>
                )}
              </form>
            </More>
          </div>
        )}
      </>
    );
  };

  return (
    <Section id="shows" title="Shows" desc="Know which YouTube videos and Spotify episodes you’ve finished, and where you stopped, whichever platform or device you used.">
      <Panel
        title="Phone and tablet sync"
        desc="Trove’s server reads what you play in the Spotify and YouTube apps, every hour and whenever you open Shows, with your sign-ins. They’re kept encrypted and only used by your Trove. No Spotify Premium or API keys needed."
        foot={
          <>
            <button className="btn sm" onClick={() => syncNow(false)} disabled={!any || busy === 'sync'}>
              {busy === 'sync' ? <span className="spinner" /> : <RefreshCw size={14} />} Sync now
            </button>
            <button className="btn ghost sm" onClick={() => syncNow(true)} disabled={!any || busy === 'sync'} title="Also reads further back in your Spotify library and YouTube history">
              Import older history
            </button>
            {result && (
              <Status live kind={result.kind}>
                {result.text}
              </Status>
            )}
          </>
        }
      >
        {service('spotify')}
        {service('youtube')}
      </Panel>

      <Panel>
        <Row icon={<Puzzle size={17} />} title="In the browser" desc="The Trove extension tracks YouTube and the Spotify web player as you play, and marks what you’ve started or finished right on their pages.">
          <a className="btn sm" href="#capture">
            Get the extension
          </a>
        </Row>
        <Row icon={<Smartphone size={17} />} title="On iPhone and iPad" desc="Add Trove to your Home Screen and open Shows before you press play: it syncs as it opens, shows what you finished or where you stopped on either platform, and resumes in the Spotify or YouTube app.">
          <a className="btn sm" href="/?s=shows">
            Open Shows
          </a>
        </Row>
        <Row icon={<Zap size={17} />} title="Sync the moment you stop" desc="Optional. A Shortcuts automation tells Trove whenever you close Spotify or YouTube.">
          <button className="btn sm" aria-expanded={automation} aria-controls="shows-automation" onClick={() => setAutomation(!automation)}>
            {automation ? 'Hide' : 'Set up'}
          </button>
        </Row>
        {automation && (
          <div className="set-block" id="shows-automation">
            <ol className="set-steps">
              <li>
                In the Shortcuts app, tap <strong>Automation → New → App</strong>, choose <strong>Spotify</strong> and <strong>YouTube</strong>, then <strong>Is Closed</strong> and <strong>Run Immediately</strong>.
              </li>
              <li>
                Add the action <strong>Get Contents of URL</strong>, set its method to <strong>POST</strong>, and paste this URL with one of your API keys in place of <code>&lt;api key&gt;</code>:
              </li>
            </ol>
            <CodeBox>{`${base}/api/media/sync?key=<api key>`}</CodeBox>
            <p className="set-hint">
              The hourly sync runs from the trove-ai Cloudflare worker’s cron when it has <code>TROVE_ENRICH_KEY</code>.
            </p>
          </div>
        )}
      </Panel>
    </Section>
  );
}
