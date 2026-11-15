import { $, ago, el, explain, fmt, send, until } from './common.js';

let status = null;

const typedToken = () => $('token').value.trim() || undefined;

function setMsg(id, text, kind = '') {
  $(id).className = `msg ${kind}`;
  $(id).textContent = text;
}

async function load() {
  status = await send('status');
  const { settings: s, state, capture, loggedIn } = status;

  $('token').placeholder = status.hasToken ? `Saved (${s.notionToken}) — paste to replace` : 'ntn_… or secret_…';
  $('dbInfo').replaceChildren(
    s.dataSourceId
      ? el('span', {}, 'Connected to ', el('a', { href: s.databaseUrl || '#', target: '_blank' }, el('strong', {}, s.databaseTitle || 'database')), ' ✓')
      : 'Not connected',
  );

  if (document.activeElement !== $('troveUrl')) $('troveUrl').value = s.troveUrl || '';
  $('troveKey').placeholder = s.troveKey ? 'Connected — paste to replace' : 'trv_… (Trove → Settings → API keys)';
  $('syncBrowserBookmarks').checked = !!s.syncBrowserBookmarks;
  for (const k of ['watchYouTube', 'watchSpotify', 'watchBadges', 'watchDim']) $(k).checked = s[k] !== false;
  $('syncPinterest').checked = !!s.syncPinterest;
  const pin = state.pinterest;
  if (pin) {
    $('pinMsg').textContent = pin.running
      ? `Importing ${pin.todo ? `${fmt(pin.done || 0)}/${fmt(pin.todo)} new pins` : 'your boards'}…`
      : pin.error
        ? pin.error
        : `${fmt(pin.total)} pins${pin.username ? ` from @${pin.username}` : ''} · ${fmt(pin.saved)} new${pin.moved ? ` · ${pin.moved} moved` : ''}${pin.errors ? ` · ${pin.errors} failed` : ''}${pin.at ? ` · ${new Date(pin.at).toLocaleString()}` : ''}`;
  }
  const bi = state.bookmarksImport;
  if (bi) $('bmMsg').textContent = `${bi.running ? 'Importing' : 'Imported'} ${fmt(bi.done)}/${fmt(bi.total)} · ${fmt(bi.saved)} new${bi.errors ? ` · ${bi.errors} errors` : ''}`;
  $('interval').value = String(s.intervalMin);
  for (const k of ['archiveMedia', 'replyContext', 'rawJson', 'notify', 'removeFromX']) $(k).checked = !!s[k];
  $('threads').value = s.threads;
  $('maxVideo').value = s.maxVideoMB;
  if (document.activeElement !== $('rules')) $('rules').value = s.rules || '';

  const bf = state.backfill;
  const bfText = {
    idle: 'Not started yet.',
    running: `Running — ${fmt(bf.scanned)} checked, ${fmt(bf.saved)} added so far.`,
    paused: `Paused — ${fmt(bf.scanned)} checked, ${fmt(bf.saved)} added${bf.pausedUntil ? `, resumes in ${until(bf.pausedUntil)}` : ''}.`,
    stopped: `Stopped — ${fmt(bf.scanned)} checked, ${fmt(bf.saved)} added. Resume any time.`,
    error: `Interrupted — ${fmt(bf.scanned)} checked. It retries automatically.`,
    done: `Complete ${ago(bf.finishedAt)} — ${fmt(bf.scanned)} bookmarks checked, ${fmt(bf.saved)} added.`,
  }[bf.status];
  $('bfInfo').textContent = bfText;
  $('bfStart').textContent = ['paused', 'stopped', 'error'].includes(bf.status) ? 'Resume' : 'Start';
  $('bfStart').disabled = bf.status === 'running' || !s.dataSourceId;
  $('bfStop').disabled = bf.status !== 'running';
  $('bfRestart').disabled = !s.dataSourceId;
  $('indexInfo').textContent = `${fmt(state.total)} posts known${state.indexBuiltAt ? ` · rebuilt ${ago(state.indexBuiltAt)}` : ''}.`;

  const opLine = (op) => (capture[op] ? `learned ${ago(capture[op])}` : 'not learned yet');
  const limits = Object.entries(capture.rateLimits || {}).map(([k, v]) => `${k.slice(3)} until ${new Date(v).toLocaleTimeString()}`);
  $('xInfo').replaceChildren(
    el('dt', {}, 'Session'), el('dd', {}, loggedIn ? 'Logged in ✓' : el('span', { class: 'msg err' }, 'Not logged in to x.com in this browser')),
    el('dt', {}, 'Bookmarks request'), el('dd', {}, opLine('Bookmarks')),
    el('dt', {}, 'Thread request'), el('dd', {}, opLine('TweetDetail')),
    ...(limits.length ? [el('dt', {}, 'Rate limited'), el('dd', {}, limits.join(', '))] : []),
  );

  $('log').replaceChildren(
    ...state.log.map((l) =>
      el('div', { class: l.level === 'error' ? 'e' : l.level === 'warn' ? 'w' : '' }, `${new Date(l.t).toLocaleString()}  ${l.msg}${l.extra ? ' — ' + l.extra : ''}`),
    ),
  );
  if (!state.log.length) $('log').append(el('div', { class: 'muted' }, 'Nothing yet.'));
}

async function saveSettings(patch) {
  await send('saveSettings', { patch });
}

// ---- Notion ----

$('saveToken').onclick = async () => {
  const token = typedToken();
  if (!token) return setMsg('tokenMsg', 'Paste a token first.', 'err');
  setMsg('tokenMsg', 'Checking…');
  try {
    const r = await send('testNotion', { token });
    await send('setToken', { token });
    $('token').value = '';
    setMsg('tokenMsg', `Connected to workspace “${r.workspace}” as ${r.bot} ✓`, 'ok');
    load();
  } catch (e) {
    setMsg('tokenMsg', e.message, 'err');
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
};

async function createIn(parentId, label) {
  setMsg('dbMsg', `Creating database in ${label}…`);
  try {
    const r = await send('createDatabase', { token: typedToken(), parentId, title: 'Trove' });
    setMsg('dbMsg', 'Database created ✓ — archiving your bookmarks now.', 'ok');
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
      el('button', { onclick: () => createIn(null, 'the workspace top level') }, '⤒ Workspace top level (if the integration allows it)'),
      ...pages.filter((p) => p.parent !== 'data_source_id' && p.parent !== 'database_id').map((p) => el('button', { onclick: () => createIn(p.id, `“${p.title}”`) }, `📄 ${p.title}`)),
    );
  } catch (e) {
    $('parents').replaceChildren(el('div', { class: 'msg err' }, e.message));
  }
};
$('parentQuery').onkeydown = (e) => e.key === 'Enter' && $('searchParents').click();

$('useDb').onclick = async () => {
  setMsg('dbMsg', 'Connecting…');
  try {
    await send('useDatabase', { token: typedToken(), id: $('dbLink').value.trim() });
    setMsg('dbMsg', 'Connected ✓ — archiving your bookmarks now.', 'ok');
    $('useBox').hidden = true;
    load();
  } catch (e) {
    setMsg('dbMsg', e.message, 'err');
  }
};

// ---- Trove app ----

$('saveTrove').onclick = async () => {
  setMsg('troveMsg', 'Checking…');
  try {
    const key = $('troveKey').value.trim() || undefined;
    const r = await send('setTrove', { url: $('troveUrl').value.trim() || 'https://trove.mariomedpar.com', key });
    $('troveKey').value = '';
    setMsg('troveMsg', `Connected ✓ (key “${r.via}”)`, 'ok');
    load();
  } catch (e) {
    setMsg('troveMsg', e.message, 'err');
  }
};
$('syncBrowserBookmarks').onchange = () => saveSettings({ syncBrowserBookmarks: $('syncBrowserBookmarks').checked });
$('syncPinterest').onchange = () => saveSettings({ syncPinterest: $('syncPinterest').checked });
$('syncPinterestNow').onclick = async () => {
  $('syncPinterestNow').disabled = true;
  await send('syncPinterest');
  $('pinMsg').textContent = 'Reading your boards…';
  setTimeout(() => ($('syncPinterestNow').disabled = false), 5000);
};
// ---- YouTube & Spotify progress ----

for (const k of ['watchYouTube', 'watchSpotify', 'watchBadges', 'watchDim']) $(k).onchange = () => saveSettings({ [k]: $(k).checked });

async function loadWatch() {
  try {
    const { watch: w } = await send('watchStatus');
    $('watchInfo').textContent = `${fmt(w.episodes)} episodes known · ${fmt(w.finished)} finished · ${fmt(w.started)} in progress · updated ${ago(w.syncedAt)}${w.pending ? ` · ${w.pending} waiting to upload` : ''}`;
  } catch (e) {
    $('watchInfo').textContent = e.message;
  }
  try {
    const s = await send('serverSync');
    const side = (x, label) => [
      el('dt', {}, label),
      el('dd', {}, !x.connected ? el('span', { class: 'muted' }, 'Not connected') : x.needsSignIn ? el('span', { class: 'msg err' }, 'Sign-in expired — connect again') : x.error ? el('span', { class: 'msg err' }, x.error) : `Connected${x.user ? ` as ${x.user}` : ''} ✓${x.at ? ` · synced ${ago(x.at)}` : ''}`),
    ];
    $('serverInfo').replaceChildren(...side(s.spotify, 'Spotify'), ...side(s.youtube, 'YouTube'));
  } catch (e) {
    $('serverInfo').replaceChildren(el('dt', {}, 'Server sync'), el('dd', { class: 'msg err' }, e.message));
  }
  // A private window with Trove allowed in it: offer its sign-ins.
  const stores = await chrome.cookies.getAllCookieStores().catch(() => []);
  const incognito = stores.find((st) => st.id !== '0' && st.tabIds?.length);
  $('sendPrivate').hidden = !incognito;
  $('sendPrivate').dataset.store = incognito?.id || '';
}

$('watchRefresh').onclick = async () => {
  $('watchRefresh').disabled = true;
  try {
    await send('watchSync');
  } catch (e) {
    $('watchInfo').textContent = e.message;
  }
  $('watchRefresh').disabled = false;
  loadWatch();
};

async function shareSignIns(opts, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Connecting…';
  setMsg('sendMsg', '');
  try {
    const { result } = await send('shareSignIns', opts);
    const parts = [];
    const name = { spotify: 'Spotify', youtube: 'YouTube' };
    for (const k of ['spotify', 'youtube']) {
      const r = result[k];
      if (!r) continue;
      if (r.error) parts.push(`${name[k]}: ${r.error}`);
      else if (r.missing) {
        if (!opts.storeId || k === 'youtube') parts.push(`${name[k]}: not signed in ${opts.storeId ? 'in the private window' : 'in this browser'}`);
      } else parts.push(k === 'spotify' ? `Spotify connected as ${r.name || r.username} ✓` : `YouTube connected ✓ (${r.videos} videos in your history)`);
    }
    const bad = Object.values(result).some((r) => r?.error) || (opts.storeId && result.youtube?.missing);
    setMsg('sendMsg', parts.join(' · ') + (!bad && opts.storeId ? ' — you can close the private window now.' : ''), bad ? 'err' : 'ok');
  } catch (e) {
    setMsg('sendMsg', e.message, 'err');
  }
  button.textContent = label;
  button.disabled = false;
  loadWatch();
}

$('sendSpotify').onclick = () => shareSignIns({ spotify: true, youtube: false }, $('sendSpotify'));
$('sendYouTube').onclick = () => {
  if (!confirm('Send this browser\'s YouTube sign-in to your Trove server?\n\nIt works, but YouTube may end a session used from two places. A private-window sign-in lasts longer: see the note below.')) return;
  shareSignIns({ spotify: false, youtube: true }, $('sendYouTube'));
};
$('sendPrivate').onclick = () => shareSignIns({ storeId: $('sendPrivate').dataset.store, spotify: true, youtube: true }, $('sendPrivate'));

$('importBookmarks').onclick = async () => {
  $('importBookmarks').disabled = true;
  await send('importBookmarks');
  $('bmMsg').textContent = 'Importing…';
  setTimeout(() => ($('importBookmarks').disabled = false), 5000);
};

// ---- Sync ----

$('interval').onchange = () => saveSettings({ intervalMin: Number($('interval').value) });
$('bfStart').onclick = () => send('backfill').then(load);
$('bfStop').onclick = () => send('stopBackfill').then(load);
$('bfRestart').onclick = () => send('backfill', { restart: true }).then(load);
$('rebuild').onclick = async () => {
  $('rebuild').disabled = true;
  $('rebuild').textContent = 'Rebuilding…';
  try {
    const r = await send('rebuildIndex');
    $('rebuild').textContent = `Found ${fmt(r.found)} posts ✓`;
  } catch (e) {
    $('rebuild').textContent = explain(e);
  }
  setTimeout(() => {
    $('rebuild').textContent = 'Rebuild index from Notion';
    $('rebuild').disabled = false;
  }, 3000);
  load();
};

// ---- content ----

for (const k of ['archiveMedia', 'replyContext', 'rawJson', 'notify']) $(k).onchange = () => saveSettings({ [k]: $(k).checked });
$('threads').onchange = () => saveSettings({ threads: $('threads').value });
$('maxVideo').onchange = () => saveSettings({ maxVideoMB: Math.max(5, Number($('maxVideo').value) || 512) });
$('saveRules').onclick = async () => {
  await saveSettings({ rules: $('rules').value });
  setMsg('rulesMsg', 'Saved ✓ — applies to newly archived posts.', 'ok');
};

// ---- X ----

$('removeFromX').onchange = () => {
  if ($('removeFromX').checked && !confirm('Archived posts will be removed from your X bookmarks. Continue?')) {
    $('removeFromX').checked = false;
    return;
  }
  saveSettings({ removeFromX: $('removeFromX').checked });
};
$('capture').onclick = async () => {
  $('capture').disabled = true;
  $('capture').textContent = 'Opening x.com…';
  try {
    const r = await send('captureNow');
    $('capture').textContent = r.captured ? 'Connected ✓' : 'Could not learn — open x.com/i/bookmarks once';
  } catch (e) {
    $('capture').textContent = explain(e);
  }
  setTimeout(() => {
    $('capture').textContent = 'Refresh X connection';
    $('capture').disabled = false;
  }, 3000);
  load();
};
$('resetCapture').onclick = () => send('resetCapture').then(load);

$('copyLog').onclick = async () => {
  const lines = status.state.log.map((l) => `${new Date(l.t).toISOString()} [${l.level}] ${l.msg}${l.extra ? ' — ' + l.extra : ''}`);
  await navigator.clipboard.writeText(lines.join('\n'));
  $('copyLog').textContent = 'Copied ✓';
  setTimeout(() => ($('copyLog').textContent = 'Copy'), 1500);
};

let queued = null;
chrome.storage.onChanged.addListener((ch) => {
  if (!(ch.state || ch.settings || ch.xcap) || queued) return;
  queued = setTimeout(() => {
    queued = null;
    load();
  }, 500);
});

load().then(() => {
  if (location.hash === '#activity') $('activity').scrollIntoView();
  if (location.hash === '#watch') $('watch').scrollIntoView();
});
loadWatch();
