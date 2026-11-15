// chrome.storage helpers: settings, runtime state, activity log and the
// dedupe index (one key per saved post: "p:<postId>" -> Notion page id).

export const DEFAULTS = {
  notionToken: '',
  databaseId: '',
  dataSourceId: '',
  databaseUrl: '',
  databaseTitle: '',
  intervalMin: 30,
  archiveMedia: true,
  maxVideoMB: 512,
  threads: 'smart', // smart | always | off
  replyContext: true,
  rawJson: true,
  rules: '',
  removeFromX: false,
  notify: true,
  troveUrl: 'https://trove.mariomedpar.com',
  troveKey: '',
  syncBrowserBookmarks: false,
  syncPinterest: false,
  // Watch progress on youtube.com and open.spotify.com
  watchYouTube: true,
  watchSpotify: true,
  watchBadges: true,
  watchDim: true,
};

const local = () => chrome.storage.local;

export async function getSettings() {
  const { settings } = await local().get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await local().set({ settings: next });
  return next;
}

const STATE_DEFAULTS = {
  total: 0,
  lastSyncAt: null,
  lastSyncAdded: 0,
  lastError: null,
  running: null, // { kind, startedAt }
  backfill: { status: 'idle', cursor: null, scanned: 0, saved: 0, pages: 0, startedAt: null, finishedAt: null, pausedUntil: null },
  recent: [],
  log: [],
  indexBuiltAt: null,
};

export async function getState() {
  const { state } = await local().get('state');
  return { ...STATE_DEFAULTS, ...(state || {}), backfill: { ...STATE_DEFAULTS.backfill, ...(state?.backfill || {}) } };
}

let stateWrite = Promise.resolve();

/** Serialized read-modify-write so concurrent updates never clobber each other. */
export function updateState(fn) {
  stateWrite = stateWrite.then(async () => {
    const s = await getState();
    const next = (await fn(s)) || s;
    await local().set({ state: next });
    return next;
  });
  return stateWrite;
}

export function log(level, msg, extra) {
  const entry = { t: Date.now(), level, msg: String(msg).slice(0, 500) };
  if (extra) entry.extra = String(extra).slice(0, 300);
  if (level === 'error') console.warn('[trove]', msg, extra || '');
  return updateState((s) => {
    s.log = [entry, ...s.log].slice(0, 120);
    if (level === 'error') s.lastError = entry;
    return s;
  });
}

// ---------- dedupe index ----------

const key = (id) => `p:${id}`;

/** Returns the subset of ids already saved. */
export async function savedIds(ids) {
  if (!ids.length) return new Set();
  const got = await local().get(ids.map(key));
  return new Set(Object.keys(got).map((k) => k.slice(2)));
}

export async function pageIdFor(id) {
  return (await local().get(key(id)))[key(id)] || null;
}

export async function markSaved(id, pageId, recentEntry) {
  await local().set({ [key(id)]: pageId || '1' });
  await updateState((s) => {
    s.total += 1;
    if (recentEntry) s.recent = [recentEntry, ...s.recent.filter((r) => r.id !== id)].slice(0, 12);
    return s;
  });
}

/** Merge ids from Notion into the index (keeps local entries, so deleted pages are not re-imported). */
export async function mergeIndex(map) {
  const entries = Object.entries(map);
  const existing = await savedIds(entries.map(([id]) => id));
  const add = {};
  for (const [id, pageId] of entries) if (!existing.has(id)) add[key(id)] = pageId;
  if (Object.keys(add).length) await local().set(add);
  const total = await countIndex();
  await updateState((s) => {
    s.total = total;
    s.indexBuiltAt = Date.now();
    return s;
  });
  return Object.keys(add).length;
}

export async function countIndex() {
  const all = await local().get(null);
  return Object.keys(all).filter((k) => k.startsWith('p:')).length;
}

export async function clearIndex() {
  const all = await local().get(null);
  await local().remove(Object.keys(all).filter((k) => k.startsWith('p:')));
  await updateState((s) => {
    s.total = 0;
    s.indexBuiltAt = null;
    return s;
  });
}
