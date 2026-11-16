import { $, ago, el, explain, fmt, send, until } from './common.js';
import { mapPosition } from '../lib/progress.js';

let activeTab = null;
let saved = null;

async function render() {
  let s;
  try {
    s = await send('status');
  } catch (e) {
    $('alert').hidden = false;
    $('alert').textContent = e.message;
    return;
  }
  const { state, settings, job, loggedIn } = s;
  const bf = state.backfill;
  const configured = s.hasToken && settings.dataSourceId;

  // status pill
  const pill = $('status');
  pill.className = 'pill';
  let label = 'Idle';
  if (job) {
    pill.classList.add('busy');
    label = { sync: 'Syncing', backfill: 'Archiving', manual: 'Saving', index: 'Indexing' }[job] || 'Working';
  } else if (!configured || !loggedIn || (state.lastError && Date.now() - state.lastError.t < 6 * 3600e3)) {
    pill.classList.add('err');
    label = 'Needs attention';
  } else {
    pill.classList.add('ok');
    label = 'Up to date';
  }
  $('statusText').textContent = label;

  // alert
  const alert = $('alert');
  alert.hidden = true;
  alert.replaceChildren();
  if (!configured) {
    alert.hidden = false;
    alert.append('Connect your Notion database. ', el('button', { class: 'link', onclick: () => chrome.runtime.openOptionsPage() }, 'Open settings'));
  } else if (!loggedIn) {
    alert.hidden = false;
    alert.append('Log in to ', el('a', { href: 'https://x.com/login', target: '_blank' }, 'x.com'), ' in this browser so Trove can archive your X bookmarks.');
  } else if (state.lastError && Date.now() - state.lastError.t < 6 * 3600e3 && !job) {
    alert.hidden = false;
    alert.textContent = explain({ code: state.lastError.extra, msg: state.lastError.msg });
  }

  $('total').textContent = fmt(state.total);
  const next = settings.intervalMin;
  $('syncInfo').innerHTML = '';
  $('syncInfo').append(
    el('div', {}, `Last sync ${ago(state.lastSyncAt)}${state.lastSyncAdded ? ` · +${state.lastSyncAdded}` : ''}`),
    el('div', {}, `Auto-sync every ${next >= 60 ? next / 60 + 'h' : next + 'm'}`),
  );

  // backfill
  const box = $('backfill');
  box.hidden = !configured || bf.status === 'idle';
  const toggle = $('bfToggle');
  const bar = $('bfBar');
  bar.classList.toggle('indeterminate', bf.status === 'running');
  bar.firstElementChild.style.width = bf.status === 'done' ? '100%' : '0';
  if (bf.status === 'done') {
    $('bfTitle').textContent = 'Full archive complete ✓';
    $('bfInfo').textContent = `${fmt(bf.scanned)} bookmarks checked · ${fmt(bf.saved)} added · ${ago(bf.finishedAt)}`;
    toggle.textContent = 'Re-scan';
    toggle.onclick = () => send('backfill', { restart: true }).then(render);
  } else {
    $('bfTitle').textContent =
      bf.status === 'running' ? 'Archiving all bookmarks…' : bf.status === 'paused' ? 'Archive paused' : bf.status === 'stopped' ? 'Archive stopped' : 'Archive interrupted';
    const why = bf.status === 'paused' && bf.pausedUntil ? ` · resumes in ${until(bf.pausedUntil)}` : '';
    $('bfInfo').textContent = `${fmt(bf.scanned)} checked · ${fmt(bf.saved)} added${why}`;
    toggle.textContent = bf.status === 'running' ? 'Stop' : 'Resume';
    toggle.onclick = () => send(bf.status === 'running' ? 'stopBackfill' : 'backfill').then(render);
  }

  // recent
  $('recentWrap').hidden = !state.recent.length;
  $('recent').replaceChildren(
    ...state.recent.slice(0, 5).map((r) =>
      el('li', {}, el('a', { href: r.url || '#', target: '_blank', title: r.title }, el('span', { class: 't' }, r.title), el('span', { class: 'when' }, ago(r.at)))),
    ),
  );

  $('syncBtn').disabled = !configured || job === 'sync';
  $('openApp').onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: settings.troveUrl || settings.databaseUrl });
  };
  if (!settings.troveUrl) $('saveState').textContent = 'Connect the Trove app in Settings to save any page.';
}

function renderSave() {
  const box = $('saveBox');
  if (!activeTab || !/^https?:/.test(activeTab.url || '')) return (box.hidden = true);
  box.hidden = false;
  const host = new URL(activeTab.url).hostname;
  $('pageIcon').src = `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
  $('pageTitle').textContent = activeTab.title || host;
  const b = $('saveBtn');
  if (saved) {
    b.textContent = 'Saved ✓ — open in Trove';
    b.classList.remove('primary');
  }
}

$('syncBtn').onclick = async () => {
  $('syncBtn').disabled = true;
  $('syncBtn').textContent = 'Syncing…';
  try {
    const r = await send('sync');
    $('syncBtn').textContent = r.added ? `+${r.added} saved` : 'Up to date';
  } catch (e) {
    $('syncBtn').textContent = 'Sync now';
    $('alert').hidden = false;
    $('alert').textContent = explain(e);
  }
  setTimeout(() => ($('syncBtn').textContent = 'Sync now'), 2500);
  render();
};

$('saveBtn').onclick = async () => {
  const b = $('saveBtn');
  const s = await send('status');
  if (saved) {
    chrome.tabs.create({ url: `${s.settings.troveUrl}/?item=${saved.id}` });
    return window.close();
  }
  b.disabled = true;
  b.textContent = 'Saving…';
  try {
    const r = await send('savePage', { tabId: activeTab.id });
    saved = r.item || saved;
    b.textContent = r.created === false || r.status === 'exists' ? 'Already in Trove ✓' : 'Saved ✓';
    b.classList.remove('primary');
    b.disabled = false;
    if (r.item) saved = r.item;
  } catch (e) {
    b.textContent = 'Save to Trove';
    b.disabled = false;
    $('alert').hidden = false;
    $('alert').textContent = explain(e);
  }
};

$('openOptions').onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};
$('openLog').onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('ui/options.html#activity') });
};

const clock = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
const NAME = { yt: 'YouTube', sp: 'Spotify' };
const linkTo = (p, id, pos) => (p === 'yt' ? `https://www.youtube.com/watch?v=${id}${pos > 5 ? `&t=${Math.floor(pos)}s` : ''}` : `https://open.spotify.com/episode/${id}${pos > 5 ? `?t=${Math.floor(pos)}` : ''}`);

/** The video or episode in this tab: have I seen it, on which platform, where was I. */
async function renderWatch() {
  if (!activeTab?.url) return;
  let r;
  try {
    r = await send('watchTab', { url: activeTab.url });
  } catch {
    return;
  }
  if (!r.ref) return;
  const box = $('watchBox');
  box.hidden = false;
  const card = r.card;
  const here = r.ref.p;
  $('watchWhat').textContent = here === 'yt' ? 'YouTube video' : 'Spotify episode';
  const st = $('watchState');
  const meter = $('watchMeter');
  const actions = $('watchActions');
  actions.replaceChildren();
  st.className = 'st';
  meter.hidden = true;
  if (!card || card.status === 'new') {
    st.textContent = 'Not played yet, on YouTube or Spotify';
    return;
  }
  if (card.status === 'finished') {
    st.classList.add('done');
    const on = card.doneOn && !['both', 'manual', here].includes(card.doneOn) ? ` on ${NAME[card.doneOn]}` : '';
    st.textContent = `✓ Finished${on}${card.finishedAt ? ` · ${new Date(card.finishedAt).toLocaleDateString()}` : ''}`;
  } else if (card.seen && !card.resume && (card.pct || 0) < 0.02) {
    st.textContent = `Seen on ${NAME[card.seen]}, position not saved`;
  } else {
    const res = card.resume;
    st.textContent = `${Math.round((card.pct || 0) * 100)}% heard${res ? ` · last at ${clock(res.pos)} on ${NAME[res.p]}` : ''}`;
    meter.hidden = false;
    meter.firstElementChild.style.width = `${Math.round((card.pct || 0) * 100)}%`;
  }
  const other = here === 'yt' ? 'sp' : 'yt';
  if (card[other]?.id) {
    const res = card.status === 'started' ? card.resume : null;
    // The other copy may be longer or shorter (intro, ads): map the time onto it.
    const pos = !res ? 0 : res.p === other ? res.pos : mapPosition(res.pos, res.dur || card[res.p]?.dur, card[other].dur).pos;
    actions.append(el('a', { class: 'btn', href: linkTo(other, card[other].id, pos), target: '_blank' }, `Open on ${NAME[other]}${pos > 5 ? ` at ${clock(pos)}` : ''}`));
  }
  const toggle = el('button', {}, card.status === 'finished' ? 'Not finished' : 'Mark finished');
  toggle.onclick = async () => {
    toggle.disabled = true;
    try {
      await send('watchMark', { id: card.id, patch: { status: card.status === 'finished' ? 'unfinished' : 'finished' } });
      renderWatch();
    } catch (e) {
      toggle.textContent = e.message;
    }
  };
  actions.append(toggle);
}

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  activeTab = tab || null;
  renderSave();
  render();
  renderWatch();
  if (activeTab && /^https?:/.test(activeTab.url || '')) {
    send('lookup', { url: activeTab.url })
      .then((r) => {
        saved = r.item;
        renderSave();
      })
      .catch(() => {});
  }
});
let queued = null;
chrome.storage.onChanged.addListener((ch) => {
  if (!(ch.state || ch.settings) || queued) return;
  queued = setTimeout(() => {
    queued = null;
    render();
  }, 400);
});
