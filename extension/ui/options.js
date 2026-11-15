import { $, ago, el, explain, fmt, send, until } from './common.js';

let status = null;

// ---------- small helpers ----------

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

function setMsg(id, text, kind = '') {
  $(id).className = `msg ${kind}`;
  $(id).textContent = text;
}

async function saveSettings(patch, note = 'Saved') {
  await send('saveSettings', { patch });
  toast(note);
}

/** Run an action from a button: busy label while it runs, the label back after. */
async function busy(button, label, fn) {
  const before = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = before;
  }
}

/** Which of YouTube and Spotify a cookie store (this browser, or a private window's) is signed in to. */
async function signedIn(storeId) {
  const opt = storeId ? { storeId } : {};
  const sp = await chrome.cookies.get({ url: 'https://open.spotify.com', name: 'sp_dc', ...opt }).catch(() => null);
  const yt = await chrome.cookies.getAll({ domain: 'youtube.com', ...opt }).catch(() => []);
  return { spotify: !!sp?.value, youtube: yt.some((c) => c.name === 'SAPISID' || c.name === '__Secure-3PAPISID') };
}

/** An open private window's cookie store (visible only when Trove is allowed in private windows). */
async function privateStore() {
  const stores = await chrome.cookies.getAllCookieStores().catch(() => []);
  return stores.find((s) => s.id !== '0' && s.tabIds?.length) || null;
}

$('version').textContent = `Version ${chrome.runtime.getManifest().version}`;

// ---------- account ----------

function showConnForm(show) {
  $('connForm').hidden = !show;
  $('connView').hidden = show && !status?.settings?.troveKey;
  $('connChange').hidden = show;
  if (show) $(status?.settings?.troveKey ? 'troveKey' : 'troveUrl').focus();
}

async function loadAccount() {
  const s = status.settings;
  if (document.activeElement !== $('troveUrl')) $('troveUrl').value = s.troveUrl || '';
  const host = (() => {
    try {
      return new URL(s.troveUrl).host;
    } catch {
      return s.troveUrl || '';
    }
  })();
  const paint = (kind, title, sub, pill) => {
    $('connDot').className = `dot ${kind}`;
    $('connTitle').textContent = title;
    $('connSub').textContent = sub;
    $('connPill').className = `pill ${kind}`;
    $('connPillText').textContent = pill;
  };
  if (!s.troveKey) {
    paint('err', 'Not connected', 'Add your Trove app and an API key to start.', 'Not connected');
    showConnForm(true);
    $('connCancel').hidden = true;
    return;
  }
  $('connCancel').hidden = false;
  const h = await send('troveHealth').catch((e) => ({ error: e.message }));
  if (h.authenticated) paint('ok', 'Connected', `${host} · key “${h.via}”`, 'Connected');
  else if (h.error) paint('err', 'Can’t reach Trove', h.error, 'Offline');
  else paint('err', 'Key not accepted', `${host} doesn’t accept this key. Paste a new one.`, 'Key rejected');
}

$('connChange').onclick = () => showConnForm(true);
$('connCancel').onclick = () => {
  showConnForm(false);
  setMsg('troveMsg', '');
};
$('connForm').onsubmit = async (e) => {
  e.preventDefault();
  setMsg('troveMsg', 'Checking…', 'busy');
  try {
    const key = $('troveKey').value.trim() || undefined;
    const r = await send('setTrove', { url: $('troveUrl').value.trim() || 'https://trove.mariomedpar.com', key });
    $('troveKey').value = '';
    setMsg('troveMsg', '');
    toast(`Connected with key “${r.via}”`);
    showConnForm(false);
    await load();
  } catch (err) {
    setMsg('troveMsg', err.message, 'err');
  }
};

// ---------- YouTube & Spotify ----------

for (const k of ['watchYouTube', 'watchSpotify', 'watchBadges', 'watchDim']) $(k).onchange = () => saveSettings({ [k]: $(k).checked }, 'Saved. Reload YouTube or Spotify tabs to apply.');

function paintService(p, x, err) {
  const button = p === 'sp' ? $('spConnect') : $('ytSetup');
  let kind = '';
  let label;
  if (err) {
    kind = 'err';
    label = `Can’t reach Trove: ${err}`;
  } else if (!x?.connected) label = 'Not connected';
  else if (x.needsSignIn) {
    kind = 'err';
    label = 'Sign-in expired, connect again';
  } else if (x.error) {
    kind = 'warn';
    label = `Last sync failed: ${x.error}`;
  } else {
    kind = 'ok';
    label = `Connected${x.user ? ` as ${x.user}` : ''} · ${x.at ? `synced ${ago(x.at)}` : 'first sync within the hour'}`;
  }
  $(`${p}Dot`).className = `dot ${kind}`;
  $(`${p}Status`).textContent = label;
  const ok = x?.connected && !x.needsSignIn;
  if (p === 'sp') button.textContent = ok ? 'Reconnect' : 'Connect';
  else if ($('ytGuide').hidden) button.textContent = ok ? 'Reconnect' : 'Set up';
  button.classList.toggle('primary', !ok && (p === 'sp' || $('ytGuide').hidden));
}

async function loadWatch() {
  try {
    const { watch: w } = await send('watchStatus');
    $('watchInfo').textContent = `${fmt(w.episodes)} episodes · ${fmt(w.finished)} finished · ${fmt(w.started)} in progress · updated ${ago(w.syncedAt)}${w.pending ? ` · ${w.pending} waiting to upload` : ''}`;
  } catch (e) {
    $('watchInfo').textContent = e.message;
  }
  try {
    const s = await send('serverSync');
    paintService('sp', s.spotify);
    paintService('yt', s.youtube);
  } catch (e) {
    paintService('sp', null, e.message);
    paintService('yt', null, e.message);
  }
}

$('watchRefresh').onclick = () =>
  busy($('watchRefresh'), 'Refreshing…', async () => {
    await send('watchSync').catch((e) => setMsg('svcMsg', e.message, 'err'));
    await loadWatch();
  });

$('spConnect').onclick = async () => {
  setMsg('svcMsg', '');
  if (!(await signedIn()).spotify) {
    setMsg('svcMsg', 'Sign in to open.spotify.com in this browser, then click Connect again.', 'err');
    chrome.tabs.create({ url: 'https://open.spotify.com/' });
    return;
  }
  await busy($('spConnect'), 'Connecting…', async () => {
    try {
      const { result } = await send('shareSignIns', { spotify: true, youtube: false });
      const r = result.spotify || {};
      if (r.error) setMsg('svcMsg', `Spotify: ${r.error}`, 'err');
      else toast(`Spotify connected as ${r.name || r.username}`);
    } catch (e) {
      setMsg('svcMsg', e.message, 'err');
    }
  });
  loadWatch();
};

// The YouTube guide: allow private windows → sign in there → connect → close the window.
let guideTimer = null;
let ytConnected = false;

function setStep(n, state) {
  const li = $(`step${n}`);
  li.classList.toggle('done', state === 'done');
  li.classList.toggle('current', state === 'current');
  li.querySelector('.step-num').textContent = state === 'done' ? '✓' : String(n);
}

async function refreshGuide() {
  const allowed = await chrome.extension.isAllowedIncognitoAccess().catch(() => false);
  const store = allowed ? await privateStore() : null;
  const signed = store ? (await signedIn(store.id)).youtube : false;
  setStep(1, allowed ? 'done' : 'current');
  setStep(2, !allowed ? '' : signed || ytConnected ? 'done' : 'current');
  setStep(3, ytConnected ? 'done' : signed ? 'current' : '');
  $('step1Btn').hidden = allowed;
  $('step2Btn').hidden = !allowed || signed || ytConnected;
  $('step2Btn').textContent = store ? 'Open YouTube there' : 'Open private window';
  $('step3Btn').dataset.store = store?.id || '';
  if (ytConnected) {
    $('step3Btn').textContent = store ? 'Close private window' : 'Done';
    $('step3Btn').disabled = false;
    $('step3Text').textContent = 'Connected. Close the private window so this sign-in is only used by Trove.';
  } else {
    $('step3Btn').textContent = 'Connect YouTube';
    $('step3Btn').disabled = !signed;
  }
}

function toggleGuide(open = $('ytGuide').hidden) {
  $('ytGuide').hidden = !open;
  $('ytSetup').setAttribute('aria-expanded', String(open));
  if (open) {
    $('ytSetup').textContent = 'Hide';
    $('ytSetup').classList.remove('primary');
  }
  clearInterval(guideTimer);
  if (open) {
    refreshGuide();
    guideTimer = setInterval(() => !document.hidden && refreshGuide(), 2000);
  } else loadWatch();
}

$('ytSetup').onclick = () => {
  ytConnected = false;
  setMsg('svcMsg', '');
  toggleGuide();
};
$('step1Btn').onclick = () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
$('step2Btn').onclick = async () => {
  try {
    const store = await privateStore();
    if (store) {
      const { windowId } = await chrome.tabs.get(store.tabIds[0]);
      await chrome.tabs.create({ windowId, url: 'https://www.youtube.com/' });
      await chrome.windows.update(windowId, { focused: true });
    } else await chrome.windows.create({ incognito: true, url: 'https://www.youtube.com/' });
  } catch (e) {
    setMsg('svcMsg', `Couldn’t open a private window: ${e.message}`, 'err');
  }
};
$('step3Btn').onclick = async () => {
  if (ytConnected) {
    for (const w of await chrome.windows.getAll().catch(() => [])) if (w.incognito) chrome.windows.remove(w.id).catch(() => {});
    toggleGuide(false);
    return;
  }
  setMsg('svcMsg', '');
  await busy($('step3Btn'), 'Connecting…', async () => {
    try {
      const { result } = await send('shareSignIns', { storeId: $('step3Btn').dataset.store, youtube: true, spotify: false });
      const r = result.youtube || {};
      if (r.error) setMsg('svcMsg', `YouTube: ${r.error}`, 'err');
      else if (r.missing) setMsg('svcMsg', 'No YouTube sign-in found in the private window yet.', 'err');
      else {
        ytConnected = true;
        toast(`YouTube connected · ${fmt(r.videos)} videos in your history`);
        loadWatch();
      }
    } catch (e) {
      setMsg('svcMsg', e.message, 'err');
    }
  });
  refreshGuide();
};
$('ytUseMain').onclick = async () => {
  if (!(await signedIn()).youtube) return setMsg('svcMsg', 'This browser isn’t signed in to YouTube either.', 'err');
  setMsg('svcMsg', 'Connecting…', 'busy');
  try {
    const { result } = await send('shareSignIns', { youtube: true, spotify: false });
    const r = result.youtube || {};
    if (r.error) setMsg('svcMsg', `YouTube: ${r.error}`, 'err');
    else {
      setMsg('svcMsg', '');
      toast(`YouTube connected · ${fmt(r.videos)} videos in your history`);
      toggleGuide(false);
    }
  } catch (e) {
    setMsg('svcMsg', e.message, 'err');
  }
};

// ---------- save & sync ----------

$('syncBrowserBookmarks').onchange = () => saveSettings({ syncBrowserBookmarks: $('syncBrowserBookmarks').checked });
$('syncPinterest').onchange = () => saveSettings({ syncPinterest: $('syncPinterest').checked });
$('importBookmarks').onclick = async () => {
  $('importBookmarks').disabled = true;
  await send('importBookmarks');
  $('bmMsg').textContent = 'Importing…';
  setTimeout(() => ($('importBookmarks').disabled = false), 5000);
};
$('syncPinterestNow').onclick = async () => {
  $('syncPinterestNow').disabled = true;
  await send('syncPinterest');
  $('pinMsg').textContent = 'Reading your boards…';
  setTimeout(() => ($('syncPinterestNow').disabled = false), 5000);
};

// ---------- X bookmarks ----------

const typedToken = () => $('token').value.trim() || undefined;

$('tokenChange').onclick = () => {
  $('tokenForm').hidden = !$('tokenForm').hidden;
  if (!$('tokenForm').hidden) $('token').focus();
};
$('tokenForm').onsubmit = async (e) => {
  e.preventDefault();
  const token = typedToken();
  if (!token) return setMsg('tokenMsg', 'Paste a token first.', 'err');
  setMsg('tokenMsg', 'Checking…', 'busy');
  try {
    const r = await send('testNotion', { token });
    await send('setToken', { token });
    $('token').value = '';
    $('tokenForm').hidden = true;
    setMsg('tokenMsg', '');
    toast(`Connected to “${r.workspace}”`);
    load();
  } catch (err) {
    setMsg('tokenMsg', err.message, 'err');
  }
};

$('showCreate').onclick = () => {
  $('createBox').hidden = !$('createBox').hidden;
  $('useBox').hidden = true;
  if (!$('createBox').hidden) $('searchParents').click();
};
$('showUse').onclick = () => {
  $('useBox').hidden = !$('useBox').hidden;
  $('createBox').hidden = true;
  if (!$('useBox').hidden) $('dbLink').focus();
};

async function createIn(parentId, label) {
  setMsg('dbMsg', `Creating the database in ${label}…`, 'busy');
  try {
    const r = await send('createDatabase', { token: typedToken(), parentId, title: 'Trove' });
    setMsg('dbMsg', 'Database created. Archiving your bookmarks now.', 'ok');
    $('createBox').hidden = true;
    if (r.database?.url) window.open(r.database.url, '_blank');
    load();
  } catch (e) {
    setMsg('dbMsg', e.message, 'err');
  }
}

$('searchParents').onclick = async () => {
  $('parents').replaceChildren(el('div', { class: 'muted' }, 'Searching…'));
  try {
    const { pages } = await send('listParents', { token: typedToken(), query: $('parentQuery').value.trim() });
    $('parents').replaceChildren(
      el('button', { onclick: () => createIn(null, 'the workspace top level') }, 'Workspace top level (if the integration allows it)'),
      ...pages.filter((p) => p.parent !== 'data_source_id' && p.parent !== 'database_id').map((p) => el('button', { onclick: () => createIn(p.id, `“${p.title}”`) }, p.title)),
    );
  } catch (e) {
    $('parents').replaceChildren(el('div', { class: 'msg err' }, e.message));
  }
};
$('parentQuery').onkeydown = (e) => e.key === 'Enter' && $('searchParents').click();

$('useDb').onclick = async () => {
  setMsg('dbMsg', 'Connecting…', 'busy');
  try {
    await send('useDatabase', { token: typedToken(), id: $('dbLink').value.trim() });
    setMsg('dbMsg', 'Connected. Archiving your bookmarks now.', 'ok');
    $('useBox').hidden = true;
    load();
  } catch (e) {
    setMsg('dbMsg', e.message, 'err');
  }
};

$('interval').onchange = () => saveSettings({ intervalMin: Number($('interval').value) });
$('bfStart').onclick = () => send('backfill').then(load);
$('bfStop').onclick = () => send('stopBackfill').then(load);
$('bfRestart').onclick = () => {
  if (confirm('Walk your whole X bookmark list again? Posts already archived are skipped.')) send('backfill', { restart: true }).then(load);
};
$('rebuild').onclick = () =>
  busy($('rebuild'), 'Rebuilding…', async () => {
    try {
      const r = await send('rebuildIndex');
      toast(`${fmt(r.total)} posts known`);
    } catch (e) {
      toast(explain(e));
    }
    load();
  });

for (const k of ['archiveMedia', 'replyContext', 'rawJson', 'notify']) $(k).onchange = () => saveSettings({ [k]: $(k).checked });
$('threads').onchange = () => saveSettings({ threads: $('threads').value });
$('maxVideo').onchange = () => saveSettings({ maxVideoMB: Math.max(5, Number($('maxVideo').value) || 512) });
$('saveRules').onclick = async () => {
  await send('saveSettings', { patch: { rules: $('rules').value } });
  setMsg('rulesMsg', 'Saved. Applies to posts archived from now on.', 'ok');
};
$('removeFromX').onchange = () => {
  if ($('removeFromX').checked && !confirm('Posts will be removed from your X bookmarks once archived. Continue?')) {
    $('removeFromX').checked = false;
    return;
  }
  saveSettings({ removeFromX: $('removeFromX').checked });
};
$('capture').onclick = () =>
  busy($('capture'), 'Opening x.com…', async () => {
    try {
      const r = await send('captureNow');
      toast(r.captured ? 'Connected to X' : 'Couldn’t learn it yet: open x.com/i/bookmarks once');
    } catch (e) {
      toast(explain(e));
    }
    load();
  });
$('resetCapture').onclick = () => send('resetCapture').then(load);

$('copyLog').onclick = async () => {
  const lines = status.state.log.map((l) => `${new Date(l.t).toISOString()} [${l.level}] ${l.msg}${l.extra ? ' — ' + l.extra : ''}`);
  await navigator.clipboard.writeText(lines.join('\n'));
  toast('Activity copied');
};

// ---------- render everything ----------

async function load() {
  status = await send('status');
  const { settings: s, state, capture, loggedIn } = status;

  await loadAccount();

  for (const k of ['watchYouTube', 'watchSpotify', 'watchBadges', 'watchDim']) $(k).checked = s[k] !== false;
  $('syncBrowserBookmarks').checked = !!s.syncBrowserBookmarks;
  $('syncPinterest').checked = !!s.syncPinterest;
  const pin = state.pinterest;
  if (pin) {
    $('pinMsg').textContent = pin.running
      ? `Importing ${pin.todo ? `${fmt(pin.done || 0)} of ${fmt(pin.todo)} new pins` : 'your boards'}…`
      : pin.error || `${fmt(pin.total)} pins${pin.username ? ` from @${pin.username}` : ''} · ${fmt(pin.saved)} new${pin.moved ? ` · ${pin.moved} moved` : ''}${pin.errors ? ` · ${pin.errors} failed` : ''}${pin.at ? ` · ${ago(pin.at)}` : ''}`;
  }
  const bi = state.bookmarksImport;
  if (bi) $('bmMsg').textContent = `${bi.running ? 'Importing' : 'Imported'} ${fmt(bi.done)} of ${fmt(bi.total)} · ${fmt(bi.saved)} new${bi.errors ? ` · ${bi.errors} failed` : ''}`;

  $('tokenInfo').textContent = status.hasToken ? `Saved (${s.notionToken})` : 'Not set yet';
  $('tokenChange').textContent = status.hasToken ? 'Change' : 'Add token';
  if (!status.hasToken) $('tokenForm').hidden = false;
  $('dbInfo').replaceChildren(s.dataSourceId ? el('span', {}, 'Archiving into ', el('a', { href: s.databaseUrl || '#', target: '_blank' }, s.databaseTitle || 'your database')) : 'Not connected');
  $('showCreate').textContent = s.dataSourceId ? 'Create another…' : 'Create new…';

  $('interval').value = String(s.intervalMin);
  for (const k of ['archiveMedia', 'replyContext', 'rawJson', 'notify', 'removeFromX']) $(k).checked = !!s[k];
  $('threads').value = s.threads;
  $('maxVideo').value = s.maxVideoMB;
  if (document.activeElement !== $('rules')) $('rules').value = s.rules || '';

  const bf = state.backfill;
  $('bfInfo').textContent = {
    idle: 'Walks your whole bookmark list once. Already archived posts are skipped.',
    running: `Running: ${fmt(bf.scanned)} checked, ${fmt(bf.saved)} added so far.`,
    paused: `Paused: ${fmt(bf.scanned)} checked, ${fmt(bf.saved)} added${bf.pausedUntil ? `. Resumes in ${until(bf.pausedUntil)}` : ''}.`,
    stopped: `Stopped: ${fmt(bf.scanned)} checked, ${fmt(bf.saved)} added. Resume any time.`,
    error: `Interrupted after ${fmt(bf.scanned)} checked. It retries by itself.`,
    done: `Done ${ago(bf.finishedAt)}: ${fmt(bf.scanned)} bookmarks checked, ${fmt(bf.saved)} added.`,
  }[bf.status];
  $('bfStart').textContent = ['paused', 'stopped', 'error'].includes(bf.status) ? 'Resume' : bf.status === 'done' ? 'Run again' : 'Start';
  $('bfStart').disabled = bf.status === 'running' || !s.dataSourceId;
  $('bfStop').hidden = bf.status !== 'running';
  $('bfRestart').disabled = !s.dataSourceId;
  $('rebuild').disabled = !s.dataSourceId;
  $('indexInfo').textContent = `${fmt(state.total)} posts known${state.indexBuiltAt ? `, rebuilt ${ago(state.indexBuiltAt)}` : ''}. Trove never archives a post twice.`;

  const opLine = (op) => (capture[op] ? `Learned ${ago(capture[op])}` : 'Not learned yet');
  const limits = Object.entries(capture.rateLimits || {}).map(([k, v]) => `${k.slice(3)} until ${new Date(v).toLocaleTimeString()}`);
  $('xInfo').replaceChildren(
    el('dt', {}, 'Signed in'), el('dd', {}, loggedIn ? 'Yes' : el('span', { class: 'msg err' }, 'No: log in to x.com in this browser')),
    el('dt', {}, 'Bookmarks request'), el('dd', {}, opLine('Bookmarks')),
    el('dt', {}, 'Thread request'), el('dd', {}, opLine('TweetDetail')),
    ...(limits.length ? [el('dt', {}, 'Rate limited'), el('dd', {}, limits.join(', '))] : []),
  );

  $('log').replaceChildren(...state.log.map((l) => el('div', { class: l.level === 'error' ? 'e' : l.level === 'warn' ? 'w' : '' }, `${new Date(l.t).toLocaleString()}  ${l.msg}${l.extra ? ' — ' + l.extra : ''}`)));
  if (!state.log.length) $('log').append(el('div', { class: 'muted' }, 'Nothing yet.'));
}

// Highlight the section in view.
const links = [...document.querySelectorAll('.navlink')];
const seen = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const a of links) a.setAttribute('aria-current', String(a.getAttribute('href') === `#${e.target.id}`));
    }
  },
  { rootMargin: '-30% 0px -60% 0px' },
);
for (const s of document.querySelectorAll('main > .section')) seen.observe(s);

let queued = null;
chrome.storage.onChanged.addListener((ch) => {
  if (!(ch.state || ch.settings || ch.xcap) || queued) return;
  queued = setTimeout(() => {
    queued = null;
    load();
  }, 500);
});

load().then(() => {
  const target = { '#watch': 'media', '#media': 'media', '#youtube': 'media', '#activity': 'activity', '#x': 'x', '#saving': 'saving' }[location.hash];
  if (target) $(target).scrollIntoView();
  if (location.hash === '#youtube') toggleGuide(true);
});
loadWatch();
