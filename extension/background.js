// Trove service worker. Event-driven: it sleeps between alarms and only wakes
// for scheduled X syncs, x.com bookmark actions, saves, menu clicks and UI messages.
// X posts are archived locally (richest data, uses your x.com session); everything
// else goes to the Trove web app API.

import * as X from './lib/x.js';
import * as Sync from './lib/sync.js';
import * as S from './lib/store.js';
import { Notion, parseNotionId } from './lib/notion.js';
import { BROWSER_COLLECTION, createDatabase, createViews, ensureSchema, resolveDataSource } from './lib/schema.js';
import { tweetIdFromUrl } from './lib/util.js';
import * as Trove from './lib/trove.js';
import * as Pinterest from './lib/pinterest.js';
import { videoIdOf, youtubeData } from './lib/youtube.js';
import * as Watch from './lib/watch.js';

// ---------- listeners (registered synchronously at startup) ----------

// What you play on youtube.com and open.spotify.com: outbox, uploads and the page marks.
Watch.install();

let quickTimer = null;
X.installCapture({
  onBookmarkCreated: () => {
    // Bookmarked something on x.com: archive it a few seconds later.
    clearTimeout(quickTimer);
    quickTimer = setTimeout(() => Sync.syncNew('bookmarked').catch(() => {}), 4000);
  },
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  createMenus();
  const preconfigured = await boot();
  setTimeout(() => enrichVideos().catch(() => {}), 15000);
  if (reason === 'install') chrome.runtime.openOptionsPage();
  if (preconfigured) kickoff();
  else resumeIfNeeded();
});

chrome.runtime.onStartup.addListener(() =>
  boot().then(() => {
    resumeIfNeeded();
    setTimeout(() => enrichVideos().catch(() => {}), 15000);
  }),
);

chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name === 'sync') {
    Sync.syncNew('scheduled').catch(notifyError);
    enrichVideos().catch(() => {});
    const [{ syncPinterest: on }, { pinterest }] = await Promise.all([S.getSettings(), S.getState()]);
    if (on && !pinterest?.running && Date.now() - (pinterest?.at || 0) > PINTEREST_EVERY) syncPinterest().catch(() => {});
  }
  if (name === 'tick') resumeIfNeeded();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  switch (info.menuItemId) {
    case 'trove-link':
      return tweetIdFromUrl(info.linkUrl) ? manualSave(info.linkUrl) : saveUrl({ url: info.linkUrl, title: info.selectionText || undefined });
    case 'trove-image':
      return saveUrl({ url: info.srcUrl, type: 'Image', note: info.pageUrl ? `From ${info.pageUrl}` : undefined });
    case 'trove-selection':
      return saveTab(tab, { highlight: info.selectionText });
    default:
      return saveTab(tab);
  }
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'save-current') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  saveTab(tab);
});

chrome.bookmarks.onCreated.addListener(async (_id, node) => {
  if (!node.url || !/^https?:/.test(node.url)) return;
  const { syncBrowserBookmarks } = await S.getSettings();
  if (!syncBrowserBookmarks) return;
  saveUrl({ url: node.url, title: node.title, collection: bookmarksCollection(await folderPath(node.parentId)), source: 'Browser bookmarks' }, { quiet: true });
});

// Keep synced bookmarks in step with the browser: moving a bookmark to another folder moves it
// in Trove, renaming it renames it. Deleting a bookmark keeps the archived copy.
async function syncedItem(url) {
  if (!url || !/^https?:/.test(url) || !(await S.getSettings()).syncBrowserBookmarks) return null;
  const item = await Trove.lookup(url).catch(() => null);
  // Only touch items that are filed as browser bookmarks; anything filed elsewhere is left alone.
  return item && (item.collection || '').split('/')[0] === BOOKMARKS_ROOT ? item : null;
}

/** Re-file every synced bookmark inside a node (a bookmark or a whole folder) after it moved or was renamed. */
async function refile(id) {
  const [root] = await chrome.bookmarks.getSubTree(id).catch(() => []);
  if (!root) return;
  const walk = async (n) => {
    if (n.url) {
      const item = await syncedItem(n.url);
      const collection = bookmarksCollection(await folderPath(n.parentId));
      if (item && item.collection !== collection) await Trove.update(item.id, { collection }).catch(() => {});
    }
    for (const c of n.children || []) await walk(c);
  };
  await walk(root);
}

chrome.bookmarks.onMoved.addListener((id) => refile(id));

chrome.bookmarks.onChanged.addListener(async (id, { title }) => {
  const [node] = await chrome.bookmarks.get(id).catch(() => []);
  if (!node) return;
  if (!node.url) return refile(id); // a folder was renamed
  const item = await syncedItem(node.url);
  if (item && title && title !== item.title) await Trove.update(item.id, { title }).catch(() => {});
});

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith('http')) chrome.tabs.create({ url: id });
  chrome.notifications.clear(id);
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  handle(msg)
    .then((r) => reply({ ok: true, ...(r || {}) }))
    .catch((e) => reply({ ok: false, error: e.message || String(e), code: e.code }));
  return true;
});

Sync.onActivity(updateBadge);
chrome.storage.onChanged.addListener((ch) => {
  if (ch.settings) ensureAlarms();
  if (ch.state && ch.state.newValue?.lastError?.t !== ch.state.oldValue?.lastError?.t) updateBadge();
});

// ---------- lifecycle ----------

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'trove-page', title: 'Save page to Trove', contexts: ['page', 'frame'] });
    chrome.contextMenus.create({ id: 'trove-link', title: 'Save link to Trove', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'trove-image', title: 'Save image to Trove', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'trove-selection', title: 'Save selection as highlight', contexts: ['selection'] });
  });
}

// ---------- saving to the Trove web app ----------

// Browser bookmarks all live under one collection; their folders become sub-collections.
const BOOKMARKS_ROOT = BROWSER_COLLECTION;
const bookmarksCollection = (path) => (path ? `${BOOKMARKS_ROOT}/${path}` : BOOKMARKS_ROOT);

const SKIP_FOLDERS = /^(bookmarks bar|bookmarks toolbar|barra de marcadores|favorites bar|other bookmarks|otros marcadores|mobile bookmarks|marcadores del móvil|bookmarks menu)$/i;

async function folderPath(id) {
  const parts = [];
  while (id && id !== '0') {
    const [n] = await chrome.bookmarks.get(id).catch(() => []);
    if (!n) break;
    if (n.title && !SKIP_FOLDERS.test(n.title)) parts.unshift(n.title.replace(/\//g, '-'));
    id = n.parentId;
  }
  return parts.join('/');
}

function flashBadge(text, color = '#2f7d4f') {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(updateBadge, 2500);
}

async function itemLink(item) {
  const { troveUrl } = await S.getSettings();
  return troveUrl ? `${troveUrl.replace(/\/$/, '')}/?item=${item.id}` : item.notionUrl;
}

async function saveUrl(body, { quiet = false } = {}) {
  chrome.action.setBadgeText({ text: '…' });
  try {
    const r = await Trove.save(body);
    if (!quiet) notify(await itemLink(r.item), r.created ? 'Saved to Trove ✓' : 'Already in Trove', r.item.title || body.url);
    flashBadge('✓');
    return r;
  } catch (e) {
    notify('', 'Could not save to Trove', e.message || String(e));
    updateBadge();
    throw e;
  }
}

/** Save the page in a tab: X posts locally, anything else via Trove with metadata read from the page. */
async function saveTab(tab, extra = {}) {
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    notify('', 'Trove', 'This page can’t be saved.');
    return { status: 'invalid' };
  }
  if (tweetIdFromUrl(tab.url) && !extra.highlight) return manualSave(tab.url);
  let captured = null;
  try {
    [{ result: captured }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: Trove.captureFromPage });
  } catch { /* restricted page: the server fetches it instead */ }
  const vid = videoIdOf(tab.url);
  const youtube = vid ? await youtubeData(vid).catch(() => null) : null;
  return saveUrl({
    url: tab.url,
    title: captured?.meta?.title || tab.title,
    meta: { ...(captured?.meta || {}), ...(youtube ? { youtube, html: undefined } : {}) },
    highlight: extra.highlight ?? (captured?.selection || undefined),
    ...extra,
  });
}

/** Videos saved from the phone or by agents: fill in description, duration and transcript from this browser. */
async function enrichVideos(max = 8) {
  const { troveKey } = await S.getSettings();
  if (!troveKey) return;
  const { items } = await Trove.list('type:video site:youtube.com', 40);
  for (const it of items.filter((i) => i.db === 'library' && !i.duration).slice(0, max)) {
    const vid = videoIdOf(it.url);
    if (!vid) continue;
    const data = await youtubeData(vid).catch(() => null);
    if (data) await Trove.enrich(it.id, { youtube: data }).catch(() => {});
  }
}

async function importBrowserBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  const rows = [];
  const walk = (nodes, path) => {
    for (const n of nodes) {
      if (n.url) {
        if (/^https?:/.test(n.url)) rows.push({ url: n.url, title: n.title, collection: bookmarksCollection(path.join('/')) });
      } else walk(n.children || [], n.title && !SKIP_FOLDERS.test(n.title) && n.id !== '0' ? [...path, n.title.replace(/\//g, '-')] : path);
    }
  };
  walk(tree, []);
  await S.updateState((s) => ({ ...s, bookmarksImport: { total: rows.length, done: 0, saved: 0, errors: 0, running: true, at: Date.now() } }));
  const keep = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    for (let i = 0; i < rows.length; i += 20) {
      const batch = rows.slice(i, i + 20).map((r) => ({ ...r, source: 'Browser bookmarks', archive: false }));
      let saved = 0;
      let errors = 0;
      try {
        const r = await Trove.saveMany(batch);
        saved = r.results.filter((x) => x.created).length;
        errors = r.results.filter((x) => x.error).length;
      } catch {
        errors = batch.length;
      }
      await S.updateState((s) => ({ ...s, bookmarksImport: { ...s.bookmarksImport, done: Math.min(rows.length, i + batch.length), saved: s.bookmarksImport.saved + saved, errors: s.bookmarksImport.errors + errors } }));
    }
  } finally {
    clearInterval(keep);
    await S.updateState((s) => ({ ...s, bookmarksImport: { ...s.bookmarksImport, running: false } }));
  }
  const { bookmarksImport } = await S.getState();
  notify('', 'Browser bookmarks imported', `${bookmarksImport.saved} new · ${bookmarksImport.total - bookmarksImport.saved - bookmarksImport.errors} already saved`);
  return bookmarksImport;
}

// ---------- Pinterest ----------

const PINTEREST_EVERY = 3 * 60 * 60 * 1000;

/**
 * Save every pin on your boards to Trove (each board is a sub-collection of "Pinterest"), and move
 * pins you moved to another board. Pins you delete on Pinterest stay archived in Trove.
 */
async function syncPinterest({ manual = false } = {}) {
  const { pinterest: prev } = await S.getState();
  if (prev?.running && Date.now() - (prev.startedAt || 0) < 30 * 60 * 1000) return prev;
  const set = (patch) => S.updateState((s) => ({ ...s, pinterest: { ...s.pinterest, ...patch } }));
  await set({ running: true, startedAt: Date.now(), error: null, total: 0, saved: 0, moved: 0, errors: 0 });
  const keep = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    const username = await Pinterest.me();
    if (!username) throw new Error('Log in to pinterest.com in this browser so Trove can read your saves.');
    const { pinIndex = {} } = await chrome.storage.local.get('pinIndex');
    const toSave = [];
    const toMove = [];
    let total = 0;
    for (const board of await Pinterest.boards(username)) {
      for await (const pin of Pinterest.pins(board)) {
        total++;
        const item = Pinterest.pinToItem(pin, board);
        const known = pinIndex[pin.id];
        if (!known) toSave.push([pin.id, item]);
        else if (known.c !== item.collection) toMove.push([pin.id, known.id, item.collection]);
      }
    }
    await set({ total, username });
    let saved = 0;
    let errors = 0;
    for (let i = 0; i < toSave.length; i += 8) {
      const batch = toSave.slice(i, i + 8);
      try {
        const r = await Trove.saveMany(batch.map(([, item]) => item));
        r.results.forEach((res, k) => {
          if (res?.item) pinIndex[batch[k][0]] = { id: res.item.id, c: res.item.collection };
          if (res?.created) saved++;
          if (res?.error) errors++;
        });
      } catch {
        errors += batch.length;
      }
      await chrome.storage.local.set({ pinIndex });
      await set({ saved, errors, done: Math.min(toSave.length, i + batch.length), todo: toSave.length });
    }
    let moved = 0;
    for (const [pinId, itemId, collection] of toMove) {
      try {
        await Trove.update(itemId, { collection });
        pinIndex[pinId] = { id: itemId, c: collection };
        moved++;
      } catch { /* moved again next time */ }
    }
    await chrome.storage.local.set({ pinIndex });
    await set({ running: false, at: Date.now(), saved, moved, errors });
    if (manual || saved) notify('', 'Pinterest saves synced', `${saved} new · ${total - saved - errors} already in Trove${moved ? ` · ${moved} moved` : ''}${errors ? ` · ${errors} failed` : ''}`);
    return { total, saved, moved, errors };
  } catch (e) {
    await set({ running: false, at: Date.now(), error: e.message || String(e) });
    if (manual) notify('', 'Pinterest sync failed', e.message || String(e));
    throw e;
  } finally {
    clearInterval(keep);
  }
}

/** Load the optional git-ignored config.local.json (preconfigured Notion + Trove connection).
 *  Returns true only when Notion was not connected before (first run => start the archive). */
async function loadLocalConfig() {
  const s = await S.getSettings();
  const wasConfigured = !!(s.notionToken && s.dataSourceId);
  try {
    const res = await fetch(chrome.runtime.getURL('config.local.json'));
    if (!res.ok) return false;
    const cfg = await res.json();
    // A local config is authoritative for where posts go, so a moved database is picked up on reload.
    const target = ['notionToken', 'databaseId', 'dataSourceId', 'databaseUrl', 'databaseTitle'];
    const keys = [...(!wasConfigured || (cfg.dataSourceId && cfg.dataSourceId !== s.dataSourceId) ? target : []), ...(s.troveKey ? [] : ['troveUrl', 'troveKey'])];
    const patch = Object.fromEntries(keys.filter((k) => cfg[k] && cfg[k] !== s[k]).map((k) => [k, cfg[k]]));
    if (!Object.keys(patch).length) return false;
    await S.setSettings(patch);
    await S.log('info', patch.dataSourceId && wasConfigured ? `Now saving X bookmarks to “${cfg.databaseTitle || 'Trove'}”` : 'Loaded preconfigured connection from config.local.json');
    return !wasConfigured && !!(patch.notionToken && patch.dataSourceId);
  } catch {
    return false;
  }
}

async function boot() {
  const pre = await loadLocalConfig();
  await ensureAlarms();
  await X.installHeaderRules().catch(() => {});
  updateBadge();
  return pre;
}

async function ensureAlarms() {
  const { intervalMin } = await S.getSettings();
  const a = await chrome.alarms.get('sync');
  if (!a || a.periodInMinutes !== intervalMin) await chrome.alarms.create('sync', { periodInMinutes: intervalMin, delayInMinutes: Math.min(2, intervalMin) });
  const { backfill } = await S.getState();
  if (['running', 'paused', 'error'].includes(backfill.status)) await chrome.alarms.create('tick', { periodInMinutes: 1 });
}

/** First run after Notion is connected: learn what is already archived, then archive everything. */
async function kickoff() {
  try {
    await Sync.rebuildIndex();
    await chrome.alarms.create('tick', { periodInMinutes: 1 });
    await Sync.backfill();
  } catch (e) {
    notifyError(e);
  }
}

async function resumeIfNeeded() {
  const { backfill } = await S.getState();
  if (!['running', 'paused', 'error'].includes(backfill.status)) {
    chrome.alarms.clear('tick');
    return;
  }
  if (Sync.currentJob()) return;
  if (backfill.pausedUntil && backfill.pausedUntil > Date.now()) return;
  Sync.backfill().catch(notifyError);
}

// ---------- UI feedback ----------

async function updateBadge() {
  const job = Sync.currentJob();
  const st = await S.getState();
  let text = '';
  let color = '#6b7280';
  if (job) text = '…';
  else if (st.lastError && Date.now() - st.lastError.t < 6 * 3600 * 1000) {
    text = '!';
    color = '#dc2626';
  }
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function notify(id, title, message) {
  chrome.notifications.create(id || '', { type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 0 });
}

const ACTIONABLE = {
  not_logged_in: 'Log in to x.com in this browser so Trove can read your bookmarks.',
  setup_needed: 'Open Trove settings to connect your Notion database.',
  auth: 'X rejected the request. Open x.com once (Trove learns the request format from it).',
};

async function notifyError(e) {
  const { notify: on } = await S.getSettings();
  const code = e?.code || (e?.status === 401 ? 'notion_auth' : e?.status === 404 ? 'notion_404' : null);
  const msg =
    ACTIONABLE[code] ||
    (code === 'notion_auth' ? 'Notion token was rejected. Update it in Trove settings.' : code === 'notion_404' ? 'Notion database not found or not shared with the integration.' : null);
  if (!on || !msg) return;
  const st = await S.getState();
  const last = st.notified?.[code] || 0;
  if (Date.now() - last < 6 * 3600 * 1000) return;
  await S.updateState((s) => ({ ...s, notified: { ...(s.notified || {}), [code]: Date.now() } }));
  notify(`err-${code}`, 'Trove needs attention', msg);
}

async function manualSave(url) {
  if (!tweetIdFromUrl(url)) {
    notify('', 'Trove', 'Open a post on x.com (or right-click a post link) to save it.');
    return { status: 'invalid' };
  }
  chrome.action.setBadgeText({ text: '…' });
  try {
    const r = await Sync.saveFromUrl(url);
    const { recent } = await S.getState();
    const page = recent.find((x) => x.id === r.id);
    if (r.status === 'saved') notify(page?.url || '', 'Saved to Notion ✓', r.title || 'Post archived');
    else if (r.status === 'exists') notify('', 'Already in Notion', 'This post is archived already; its thread will be refreshed if it has one.');
    return r;
  } catch (e) {
    notify('', 'Could not save post', e.message || String(e));
    notifyError(e);
    throw e;
  } finally {
    updateBadge();
  }
}

// ---------- messages from popup / options ----------

async function handle(msg) {
  switch (msg.cmd) {
    case 'status': {
      const settings = await S.getSettings();
      return {
        settings: { ...settings, notionToken: settings.notionToken ? '•••' + settings.notionToken.slice(-4) : '', troveKey: settings.troveKey ? '•••' + settings.troveKey.slice(-4) : '' },
        hasToken: !!settings.notionToken,
        state: await S.getState(),
        job: Sync.currentJob(),
        capture: await X.captureStatus(),
        loggedIn: await X.isLoggedIn(),
      };
    }
    case 'sync':
      return Sync.syncNew('manual');
    case 'backfill': {
      await chrome.alarms.create('tick', { periodInMinutes: 1 });
      Sync.backfill({ restart: !!msg.restart }).catch(notifyError);
      return {};
    }
    case 'stopBackfill':
      await Sync.stopBackfill();
      return {};
    case 'saveUrl':
      return manualSave(msg.url);
    case 'savePage': {
      const tab = await chrome.tabs.get(msg.tabId);
      return saveTab(tab);
    }
    case 'enrichVideos':
      await enrichVideos(20);
      return {};
    case 'lookup':
      return { item: await Trove.lookup(msg.url).catch(() => null) };
    case 'importBookmarks':
      importBrowserBookmarks().catch((e) => notify('', 'Bookmark import failed', e.message));
      return {};
    case 'syncPinterest':
      syncPinterest({ manual: true }).catch(() => {});
      return {};
    case 'watchStatus':
      return { watch: await Watch.status() };
    case 'watchSync':
      await Watch.flush().catch(() => {});
      await Watch.syncIndex({ force: true });
      return { watch: await Watch.status() };
    case 'watchTab':
      return Watch.forUrl(msg.url);
    case 'watchMark':
      return { card: await Watch.mark(msg.id, msg.patch) };
    case 'serverSync':
      return Watch.serverStatus();
    case 'shareSignIns':
      return { result: await Watch.shareSignIns({ storeId: msg.storeId, youtube: msg.youtube !== false, spotify: msg.spotify !== false }) };
    case 'troveHealth':
      return Trove.health();
    case 'setTrove': {
      await S.setSettings({ troveUrl: msg.url.replace(/\/$/, ''), ...(msg.key ? { troveKey: msg.key } : {}) });
      const h = await Trove.health();
      if (!h.authenticated) throw new Error('That API key was rejected');
      return { via: h.via };
    }
    case 'rebuildIndex':
      return Sync.rebuildIndex();
    case 'captureNow':
      return { captured: await X.captureViaTab(msg.op || 'Bookmarks', null, { force: true }) };
    case 'resetCapture':
      await X.resetCapture();
      return {};
    case 'saveSettings': {
      const patch = { ...msg.patch };
      delete patch.notionToken;
      delete patch.dataSourceId;
      delete patch.databaseId;
      return { settings: await S.setSettings(patch) };
    }
    case 'testNotion': {
      const token = msg.token || (await S.getSettings()).notionToken;
      const me = await new Notion(token).me();
      return { workspace: me.bot?.workspace_name, bot: me.name, maxUpload: me.bot?.workspace_limits?.max_file_upload_size_in_bytes };
    }
    case 'listParents': {
      const token = msg.token || (await S.getSettings()).notionToken;
      const res = await new Notion(token).search(msg.query || '', 'page');
      return {
        pages: res.results.map((p) => ({
          id: p.id,
          title: Object.values(p.properties || {}).find((v) => v.type === 'title')?.title?.map((t) => t.plain_text).join('') || 'Untitled',
          parent: p.parent?.type,
        })),
      };
    }
    case 'createDatabase': {
      const token = msg.token || (await S.getSettings()).notionToken;
      const notion = new Notion(token);
      const db = await createDatabase(notion, msg.parentId ? { pageId: parseNotionId(msg.parentId) } : { workspace: true }, msg.title || 'Trove');
      await createViews(notion, db);
      await connect(token, db.databaseId, db.dataSourceId, db.url, msg.title || 'Trove');
      return { database: db };
    }
    case 'useDatabase': {
      const token = msg.token || (await S.getSettings()).notionToken;
      const notion = new Notion(token);
      const id = parseNotionId(msg.id);
      if (!id) throw new Error('Paste a Notion database link or ID');
      const ds = await resolveDataSource(notion, id);
      if (!ds.dataSourceId) throw new Error('That page is not a database');
      await ensureSchema(notion, ds.dataSourceId);
      await connect(token, ds.databaseId, ds.dataSourceId, ds.url, ds.title);
      return { database: ds };
    }
    case 'setToken': {
      await new Notion(msg.token).me();
      await S.setSettings({ notionToken: msg.token });
      return {};
    }
    default:
      throw new Error(`Unknown command ${msg.cmd}`);
  }
}

async function connect(token, databaseId, dataSourceId, databaseUrl, databaseTitle) {
  const prev = await S.getSettings();
  await S.setSettings({ notionToken: token, databaseId, dataSourceId, databaseUrl, databaseTitle });
  if (prev.dataSourceId !== dataSourceId) {
    await S.clearIndex();
    await S.updateState((s) => ({ ...s, backfill: { status: 'idle', cursor: null, scanned: 0, saved: 0, pages: 0 }, recent: [] }));
  }
  kickoff();
}
