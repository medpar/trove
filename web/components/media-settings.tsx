'use client';
import { Check, Headphones, KeyRound, RefreshCw, Smartphone, Unplug } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import { api } from './api';
import { PlatformLogo } from './shows';
import { CodeBox as Code, useToast } from './ui';

type Side = { connected: boolean; at: number | null; ok: boolean | null; error: string | null; needsSignIn: boolean; user?: string | null; fromEnv?: boolean };
type Status = { spotify: Side; youtube: Side; shows: number };

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : 'never');

/** Settings → Shows: the sign-ins the server uses to read your phone's Spotify and YouTube progress. */
export function MediaSettings({ base }: { base: string }) {
  const toast = useToast();
  const { data: s, mutate } = useSWR<Status>('/api/media/connect', (u: string) => api(u));
  const [spDc, setSpDc] = useState('');
  const [cookies, setCookies] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState('');

  const connect = async (which: 'spotify' | 'youtube') => {
    setBusy(which);
    try {
      const r = await api<{ spotify?: { name: string }; youtube?: { videos: number } }>('/api/media/connect', { method: 'POST', json: which === 'spotify' ? { spotify: spDc } : { youtube: cookies } });
      toast.push({ text: which === 'spotify' ? `Spotify connected as ${r.spotify?.name}` : `YouTube connected · ${r.youtube?.videos ?? 0} videos in your history` });
      if (which === 'spotify') setSpDc('');
      else setCookies('');
      mutate();
    } catch (e: any) {
      toast.push({ text: `Couldn’t connect ${which === 'spotify' ? 'Spotify' : 'YouTube'}: ${e.message}` });
    } finally {
      setBusy(null);
    }
  };

  const forget = async (which: 'spotify' | 'youtube') => {
    await api(`/api/media/connect?which=${which}`, { method: 'DELETE' }).catch(() => {});
    mutate();
  };

  const syncNow = async (deep = false) => {
    setBusy('sync');
    setResult('Syncing…');
    try {
      const r = await api<Record<string, any>>(`/api/media/sync?wait=1${deep ? '&deep=1' : ''}`, { method: 'POST' });
      const part = (name: string, x: any) => (x ? (x.error ? `${name}: ${x.error}` : `${name}: ${x.events} changes`) : '');
      setResult([part('Spotify', r.spotify), part('YouTube', r.youtube), r.catalog ? `refreshed ${r.catalog.show}` : '', `${r.updated || 0} episodes updated`].filter(Boolean).join(' · '));
      mutate();
    } catch (e: any) {
      setResult(`Sync failed: ${e.message}`);
    } finally {
      setBusy(null);
    }
  };

  const row = (p: 'sp' | 'yt', x: Side | undefined) => {
    const name = p === 'sp' ? 'Spotify' : 'YouTube';
    const text = !x ? '…' : !x.connected ? 'Not connected' : x.needsSignIn ? 'The sign-in expired: connect again' : x.error ? `Last sync failed: ${x.error}` : `Connected${x.user ? ` as ${x.user}` : ''}${x.fromEnv ? ' (from an environment variable)' : ''} · last sync ${when(x.at)}`;
    return (
      <div className="status-row">
        <PlatformLogo p={p} size={16} />
        <span>
          <strong>{name}</strong>
          <span className="sub" style={x?.needsSignIn || (x?.connected && x.error) ? { color: 'var(--danger)' } : undefined}>{text}</span>
        </span>
        {x?.connected && !x.fromEnv && (
          <button className="btn ghost sm" style={{ marginInlineStart: 'auto' }} onClick={() => forget(p === 'sp' ? 'spotify' : 'youtube')}>
            <Unplug size={14} /> Disconnect
          </button>
        )}
      </div>
    );
  };

  const syncUrl = `${base}/api/media/sync?key=<api key>`;

  return (
    <section id="shows">
      <h2>Shows: YouTube &amp; Spotify</h2>
      <p>
        Trove tracks what you play on YouTube and Spotify, pairs the video and the podcast episode of the same show, and keeps where you stopped on each. In the browser the extension does it. For your
        iPhone and iPad, Trove’s server reads your Spotify played state and your YouTube watch history with your sign-ins, every hour and whenever you open Shows. No Spotify Premium or API keys needed.
      </p>
      <div className="status-list">
        {row('sp', s?.spotify)}
        {row('yt', s?.youtube)}
      </div>
      <div className="row-actions-inline">
        <button className="btn" onClick={() => syncNow(false)} disabled={busy === 'sync' || !(s?.spotify.connected || s?.youtube.connected)}>
          {busy === 'sync' ? <span className="spinner" /> : <RefreshCw size={15} />} Sync now
        </button>
        <button className="btn ghost" onClick={() => syncNow(true)} disabled={busy === 'sync' || !(s?.spotify.connected || s?.youtube.connected)}>
          Import older history
        </button>
        <a className="btn ghost" href="/?s=shows"><Headphones size={15} /> Open Shows</a>
        <span className="muted" role="status">{result}</span>
      </div>

      <div className="cards-2">
        <div className="mini-card">
          <h3><KeyRound size={16} /> Connect Spotify</h3>
          <p>
            Easiest: in the Trove extension’s settings, <strong>Connect Spotify</strong>. Or paste your <code>sp_dc</code> cookie: on open.spotify.com (signed in), open the developer tools → Application → Cookies → open.spotify.com → <code>sp_dc</code>.
          </p>
          <div className="row-actions-inline">
            <input className="input" type="password" value={spDc} onChange={(e) => setSpDc(e.target.value)} placeholder="sp_dc value" autoComplete="off" aria-label="Spotify sp_dc cookie" style={{ flex: 1 }} />
            <button className="btn primary" onClick={() => connect('spotify')} disabled={!spDc.trim() || busy === 'spotify'}>
              {busy === 'spotify' ? <span className="spinner" /> : <Check size={15} />} Connect
            </button>
          </div>
          <p className="field-hint">It works like your password for Spotify and stays encrypted in your Blob store. Signing out of Spotify everywhere ends it.</p>
        </div>
        <div className="mini-card">
          <h3><KeyRound size={16} /> Connect YouTube</h3>
          <p>
            Sign in to youtube.com in a <strong>private window</strong>, then in the Trove extension’s settings click <strong>Connect from private window</strong> and close that window (a sign-in no browser keeps using lasts much longer). Or paste the cookies of that window (cookies.txt, a <code>Cookie:</code> header or a JSON export).
          </p>
          <textarea className="input mono" rows={3} value={cookies} onChange={(e) => setCookies(e.target.value)} placeholder="# Netscape HTTP Cookie File … or SAPISID=…; SID=…" spellCheck={false} aria-label="YouTube cookies" />
          <div className="row-actions-inline">
            <button className="btn primary" onClick={() => connect('youtube')} disabled={!cookies.trim() || busy === 'youtube'}>
              {busy === 'youtube' ? <span className="spinner" /> : <Check size={15} />} Connect
            </button>
          </div>
        </div>
        <div className="mini-card wide">
          <h3><Smartphone size={16} /> iPhone and iPad</h3>
          <p>
            Add Trove to your Home Screen and open <strong>Shows</strong> before you pick an episode: it syncs on open and shows what you finished or where you stopped, on either platform, with buttons that open the episode in the
            Spotify or YouTube app. To have it up to date the moment you stop listening, add an automation in the Shortcuts app: <strong>Automation → New → App → Spotify and YouTube → Is Closed → Run Immediately</strong>, with
            the action <strong>Get Contents of URL</strong>, method <strong>POST</strong>, on:
          </p>
          <Code>{syncUrl}</Code>
          <p className="field-hint">Replace <code>&lt;api key&gt;</code> with any key from API keys below. The hourly sync runs from the trove-ai Cloudflare worker’s cron when it has <code>TROVE_ENRICH_KEY</code>.</p>
        </div>
      </div>
    </section>
  );
}
