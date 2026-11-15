// Watch progress in the browser. The players on youtube.com and open.spotify.com report what you
// actually play (content scripts, through a port). This module keeps an outbox in storage, so a
// closed tab, a crash or being offline never loses progress, uploads it to Trove, and keeps a local
// copy of every episode's status so the pages can mark what you've seen instantly, whichever
// platform (or device: the server syncs your phone) you played it on.

import * as S from './store.js';
import { TroveError } from './trove.js';
import { bestMatch, mediaRef, normRanges } from './progress.js';

const INDEX = 'watch:index'; // {cards: {id: card}, refs: {"yt:<id>"|"sp:<id>": id}, since, at, full}
const OUTBOX = 'watch:outbox'; // {"yt:<id>": event}
const SYNC_EVERY = 15 * 60e3;
const FULL_EVERY = 24 * 3600e3;

const ports = new Set();
let index = null;
let outbox = null;
let flushTimer = null;
let flushing = null;
let backoff = 0;
let syncing = null;

// ---------- storage ----------

// Loaded once and shared, so two messages arriving together never work on two copies.
let indexLoad = null;
let outboxLoad = null;

async function loadIndex() {
  indexLoad ||= chrome.storage.local.get(INDEX).then((r) => {
    index ||= r[INDEX] || { cards: {}, refs: {}, since: null, at: 0, full: 0 };
    return index;
  });
  await indexLoad;
  return index;
}

let saveTimer = null;
function saveIndex() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ [INDEX]: index }).catch(() => {}), 800);
}

async function loadOutbox() {
  outboxLoad ||= chrome.storage.local.get(OUTBOX).then((r) => {
    outbox ||= r[OUTBOX] || {};
    return outbox;
  });
  await outboxLoad;
  return outbox;
}

const saveOutbox = () => chrome.storage.local.set({ [OUTBOX]: outbox }).catch(() => {});

function putCards(cards) {
  if (!cards?.length) return;
  for (const c of cards) {
    if (!c?.id) continue;
    const old = index.cards[c.id];
    for (const p of ['yt', 'sp']) {
      const was = old?.[p]?.id;
      if (was && was !== c[p]?.id && index.refs[`${p}:${was}`] === c.id) delete index.refs[`${p}:${was}`];
      if (c[p]?.id) index.refs[`${p}:${c[p].id}`] = c.id;
    }
    index.cards[c.id] = c;
  }
  saveIndex();
  broadcast({ t: 'refresh' });
}

export const cardFor = (ref) => (index?.refs[ref] ? index.cards[index.refs[ref]] || null : null);

// ---------- talking to Trove ----------

async function api(path, { method = 'GET', body } = {}) {
  const { troveUrl, troveKey } = await S.getSettings();
  if (!troveUrl || !troveKey) throw new TroveError(0, 'Connect Trove in the extension settings');
  const res = await fetch(troveUrl.replace(/\/$/, '') + path, {
    method,
    headers: { authorization: `Bearer ${troveKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new TroveError(res.status, data.error || `Trove ${res.status}`);
  return data;
}

/** Pull episodes changed since the last pull (everything once a day). */
export async function syncIndex({ force = false } = {}) {
  await loadIndex();
  if (syncing) return syncing;
  if (!force && Date.now() - index.at < 60e3) return index;
  syncing = (async () => {
    const full = !index.since || Date.now() - (index.full || 0) > FULL_EVERY;
    let since = full ? null : index.since;
    let cursor = null;
    let now = null;
    const fresh = [];
    do {
      const q = new URLSearchParams();
      if (since) q.set('since', since);
      if (cursor) q.set('cursor', cursor);
      const r = await api(`/api/media/state?${q}`);
      fresh.push(...r.cards);
      cursor = r.cursor;
      now ||= r.now;
    } while (cursor);
    if (full) index = { cards: {}, refs: {}, since: null, at: 0, full: Date.now() };
    putCards(fresh);
    index.since = now || new Date(Date.now() - 120e3).toISOString();
    index.at = Date.now();
    saveIndex();
    return index;
  })().finally(() => (syncing = null));
  return syncing;
}

// ---------- outbox ----------

function mergeEvent(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (v !== undefined && v !== null && v !== '' && k !== 'ranges') out[k] = v;
  out.ranges = normRanges([...(a.ranges || []), ...(b.ranges || [])]);
  if ((a.at || 0) > (b.at || 0)) {
    out.pos = a.pos;
    out.at = a.at;
  }
  out.v = (a.v || 0) + 1;
  return out;
}

/** Queue a player observation. Urgent ones (pause, end, tab closing) go out right away. */
export async function queue(ev, { urgent = false } = {}) {
  if (!ev?.p || !ev.id) return;
  await loadOutbox();
  const key = `${ev.p}:${ev.id}`;
  outbox[key] = outbox[key] ? mergeEvent(outbox[key], ev) : { ...ev, v: 1 };
  await saveOutbox();
  scheduleFlush(urgent ? 300 : 30e3);
}

function scheduleFlush(ms) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flush().catch(() => {}), ms);
}

/** Upload everything waiting. Entries that changed while uploading stay for the next round. */
export async function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    await loadOutbox();
    const entries = Object.entries(outbox);
    if (!entries.length) return 0;
    let sent = 0;
    for (let i = 0; i < entries.length; i += 25) {
      const batch = entries.slice(i, i + 25);
      const versions = new Map(batch.map(([k, e]) => [k, e.v]));
      const done = () => {
        for (const [k, v] of versions) if (outbox[k]?.v === v) delete outbox[k];
      };
      try {
        const r = await api('/api/media/events', { method: 'POST', body: { events: batch.map(([, { v, ...ev }]) => ev) } });
        await loadIndex();
        putCards(r.cards);
        done();
        sent += batch.length;
      } catch (e) {
        if (e?.status === 400) {
          // Something Trove will never take: drop this batch (only what didn't change meanwhile).
          done();
          continue;
        }
        await saveOutbox();
        backoff = Math.min(15 * 60e3, backoff ? backoff * 2 : 60e3);
        scheduleFlush(backoff);
        throw e;
      }
    }
    await saveOutbox();
    backoff = 0;
    return sent;
  })().finally(() => (flushing = null));
  return flushing;
}

export async function pending() {
  await loadOutbox();
  return Object.keys(outbox).length;
}

// ---------- matching on pages ----------

/**
 * Items on a page that Trove has no record for by id ({key, p, id, title, dur}): find the same episode
 * on the other platform among what you've played (title + length), and tell Trove they are one.
 */
async function matchItems(items) {
  await loadIndex();
  const out = {};
  const pool = { yt: [], sp: [] };
  for (const c of Object.values(index.cards)) {
    if (c.yt && !c.sp) pool.sp.push(c); // a YouTube-only card could be this Spotify episode
    if (c.sp && !c.yt) pool.yt.push(c);
  }
  const twins = [];
  for (const it of items.slice(0, 80)) {
    const cands = pool[it.p];
    if (!cands.length || !it.title) continue;
    const other = it.p === 'yt' ? 'sp' : 'yt';
    const m = bestMatch({ title: it.title, dur: it.dur || null }, cands.map((c) => ({ ...c, dur: c[other]?.dur || null })));
    // From a page we only know title and length: demand both.
    if (!m || m.t < 0.8 || (m.d !== null && m.d < 0.9) || (m.d === null && m.t < 0.95)) continue;
    out[it.key] = m.c;
    twins.push({ p: it.p, id: it.id, title: it.title, dur: it.dur || undefined, twin: { p: other, id: m.c[other].id, by: 'page', score: m.score }, at: Date.now(), src: 'page' });
  }
  if (twins.length) api('/api/media/events', { method: 'POST', body: { events: twins } }).then((r) => putCards(r.cards)).catch(() => {});
  return out;
}

// ---------- content scripts ----------

function broadcast(msg) {
  for (const p of ports) {
    try {
      p.postMessage(msg);
    } catch {
      ports.delete(p);
    }
  }
}

/** Settings the pages need. */
async function pageSettings() {
  const s = await S.getSettings();
  return { youtube: s.watchYouTube !== false, spotify: s.watchSpotify !== false, badges: s.watchBadges !== false, dim: s.watchDim !== false, connected: !!(s.troveUrl && s.troveKey), troveUrl: s.troveUrl };
}

async function onMessage(port, msg) {
  const reply = (data) => port.postMessage({ rid: msg.rid, ...data });
  switch (msg.t) {
    case 'hello': {
      await loadIndex();
      reply({ settings: await pageSettings() });
      if (Date.now() - index.at > 3 * 60e3) syncIndex().catch(() => {});
      return;
    }
    case 'progress':
      await queue(msg.ev, { urgent: !!msg.urgent });
      return reply({ ok: true });
    case 'lookup': {
      await loadIndex();
      const cards = {};
      for (const ref of msg.refs || []) cards[ref] = cardFor(ref);
      return reply({ cards });
    }
    case 'match':
      return reply({ cards: await matchItems(msg.items || []) });
    case 'mark':
      return reply({ card: await mark(msg.id, msg.patch || {}) });
    case 'card': {
      // An episode Trove may know from your phone that this browser hasn't pulled yet.
      const r = await api(`/api/media/lookup?ref=${encodeURIComponent(msg.ref)}`).catch(() => null);
      const card = r?.results?.[msg.ref] || null;
      if (card) {
        await loadIndex();
        putCards([card]);
      }
      return reply({ card });
    }
  }
}

/** Register the port listener and the periodic work. Runs at service worker start. */
export function install() {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'trove-watch') return;
    ports.add(port);
    port.onMessage.addListener((msg) => onMessage(port, msg).catch((e) => port.postMessage({ rid: msg.rid, error: e.message || String(e) })));
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      // The tab closed or navigated away: send what it played now.
      scheduleFlush(200);
    });
  });
  chrome.alarms.get('watch').then((a) => a || chrome.alarms.create('watch', { periodInMinutes: 5, delayInMinutes: 1 })).catch(() => {});
  chrome.alarms.onAlarm.addListener(({ name }) => {
    if (name !== 'watch') return;
    flush().catch(() => {});
    loadIndex().then(() => {
      if (Date.now() - index.at > SYNC_EVERY) syncIndex().catch(() => {});
    });
  });
}

export async function status() {
  await loadIndex();
  const cards = Object.values(index.cards);
  return {
    episodes: cards.length,
    finished: cards.filter((c) => c.status === 'finished').length,
    started: cards.filter((c) => c.status === 'started').length,
    syncedAt: index.at || null,
    pending: await pending(),
  };
}

/** What Trove knows about the episode in a tab (popup). */
export async function forUrl(url) {
  const ref = mediaRef(url || '');
  if (!ref) return { ref: null, card: null };
  await loadIndex();
  const key = `${ref.p}:${ref.id}`;
  let card = cardFor(key);
  if (!card) {
    const r = await api(`/api/media/lookup?ref=${encodeURIComponent(key)}`).catch(() => null);
    card = r?.results?.[key] || null;
    if (card) putCards([card]);
  }
  return { ref, card };
}

export async function mark(id, patch) {
  await loadIndex();
  const before = index.cards[id];
  if (patch.status === 'unfinished' && before) {
    // Uploads still queued from before "Not finished" would finish it again.
    await loadOutbox();
    for (const p of ['yt', 'sp']) if (before[p]?.id) delete outbox[`${p}:${before[p].id}`];
    await saveOutbox();
  }
  const r = await api(`/api/media/episodes/${id}`, { method: 'PATCH', body: patch });
  putCards([r.card, r.split].filter(Boolean));
  return r.card;
}

/**
 * Send this browser's (or a private window's) YouTube and Spotify sign-ins to Trove, so the server
 * can read what you play on your phone without the browser open. `storeId` picks the cookie store.
 */
export async function shareSignIns({ storeId, youtube = true, spotify = true } = {}) {
  const out = {};
  if (spotify) {
    const c = await chrome.cookies.get({ url: 'https://open.spotify.com', name: 'sp_dc', ...(storeId ? { storeId } : {}) }).catch(() => null);
    if (!c?.value) out.spotify = { error: 'Not signed in to open.spotify.com in this window' };
    else out.spotify = await api('/api/media/connect', { method: 'POST', body: { spotify: c.value } }).then((r) => r.spotify).catch((e) => ({ error: e.message }));
  }
  if (youtube) {
    const all = await chrome.cookies.getAll({ domain: 'youtube.com', ...(storeId ? { storeId } : {}) }).catch(() => []);
    const jar = Object.fromEntries(all.map((c) => [c.name, c.value]));
    if (!jar.SAPISID && !jar['__Secure-3PAPISID']) out.youtube = { error: 'Not signed in to youtube.com in this window' };
    else out.youtube = await api('/api/media/connect', { method: 'POST', body: { youtube: JSON.stringify(all.map(({ name, value, domain }) => ({ name, value, domain }))) } }).then((r) => r.youtube).catch((e) => ({ error: e.message }));
  }
  return out;
}

export async function serverStatus() {
  return api('/api/media/connect');
}
