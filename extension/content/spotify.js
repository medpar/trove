// open.spotify.com: track the podcast episodes you play in the web player (music is ignored) and
// mark every episode you've started or finished, here or as a YouTube video.
(() => {
  const W = globalThis.TroveWatch;
  if (!W || globalThis.__troveSpotify) return;
  globalThis.__troveSpotify = true;

  let lib = null;
  let session = null;
  let media = null; // last report from the page-world hook
  let pendingSeek = null;
  // When the player loads the next episode before the player bar shows it, the old session ends
  // and doesn't restart until the bar catches up.
  let blocked = { id: null, until: 0 };

  const epId = (href) => /\/episode\/([A-Za-z0-9]{22})/.exec(href || '')?.[1] || null;
  const showId = (href) => /\/show\/([A-Za-z0-9]{22})/.exec(href || '')?.[1] || null;

  /** The episode in the player bar, or null (music, nothing playing). */
  function nowPlaying() {
    const w = document.querySelector('[data-testid="now-playing-widget"]');
    const a =
      w?.querySelector('a[href*="/episode/"]') ||
      document.querySelector('[data-testid="context-item-info-title"] a[href*="/episode/"], a[data-testid="context-item-link"][href*="/episode/"]');
    const id = epId(a?.getAttribute('href'));
    if (!id) return null;
    // The show is in the player bar too (never take a show link from elsewhere on the page).
    const bar = w || document.querySelector('[data-testid="now-playing-bar"], footer');
    const s = bar?.querySelector('[data-testid="context-item-info-subtitles"] a[href*="/show/"], a[href*="/show/"]');
    return { id, title: a.textContent.trim() || undefined, show: s?.textContent?.trim() || undefined, showId: showId(s?.getAttribute('href')) || undefined };
  }

  /** The player bar's clock, when the media element can't be seen. */
  function domState() {
    const pos = lib.parseClock(document.querySelector('[data-testid="playback-position"]')?.textContent || '');
    if (pos === null) return null;
    const durText = document.querySelector('[data-testid="playback-duration"]')?.textContent || '';
    const rest = lib.parseClock(durText);
    const dur = rest === null ? null : /^\s*-/.test(durText) ? pos + rest : rest;
    const btn = document.querySelector('[data-testid="control-button-playpause"]');
    return { t: pos, dur, playing: /pause/i.test(btn?.getAttribute('aria-label') || ''), seeking: false, rate: 1 };
  }

  function state() {
    if (media && Date.now() - media.at < 3000) return { t: media.t, dur: Number.isFinite(media.d) ? media.d : null, playing: !media.paused && !media.ended, seeking: media.seeking, rate: media.rate || 1 };
    return domState();
  }

  function startOrSwitch() {
    if (!lib || !W.settings?.spotify) return;
    const np = nowPlaying();
    const id = np?.id || null;
    if (session && session.id === id) return;
    if (!session && id && id === blocked.id && Date.now() < blocked.until) return;
    if (session) session.end();
    session = null;
    if (!id) return;
    const info = np;
    session = new W.Session(lib, 'sp', id, () => ({ title: info.title, show: info.show, showId: info.showId }));
    setTimeout(() => {
      if (session?.id !== id) return;
      session.armed = true;
      if (pendingSeek?.id === id) {
        window.postMessage({ __trove: 'sp-seek', t: pendingSeek.pos }, location.origin);
        pendingSeek = null;
      }
    }, 1500);
  }

  let lastTick = 0;
  function tick(force = false) {
    if (!force && Date.now() - lastTick < 900) return;
    lastTick = Date.now();
    startOrSwitch();
    const s = state();
    if (session && s) session.sample(s);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__trove !== 'sp-media') return;
    media = { ...e.data, at: Date.now() };
    if (session && (e.data.type === 'emptied' || (e.data.type === 'loadedmetadata' && session.dur && Number.isFinite(e.data.d) && Math.abs(e.data.d - session.dur) > 3))) {
      // Something else is loading in the player: close this episode before its clock is reused.
      session.end();
      blocked = { id: session.id, until: Date.now() + 8000 };
      session = null;
      return;
    }
    const urgent = ['pause', 'ended', 'seeking', 'seeked', 'ratechange', 'play'].includes(e.data.type);
    tick(urgent);
    if (e.data.type === 'pause' || e.data.type === 'ended') session?.send(true);
  });
  setInterval(() => W.alive() && tick(), 1000);
  document.addEventListener('visibilitychange', () => document.hidden && session?.send(true));
  window.addEventListener('pagehide', () => session?.end());

  // ---------- marks ----------

  function episodeLinks() {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/episode/"]')) {
      if (a.closest('[data-testid="now-playing-widget"], footer, [data-testid="context-item-info-title"]')) continue;
      if (!a.textContent.trim() || a.querySelector('img')) continue;
      const id = epId(a.getAttribute('href'));
      if (id) out.push({ a, id });
    }
    return out;
  }

  function rowLength(a) {
    const row = a.closest('[data-testid^="episode-"], [data-testid="tracklist-row"], [role="row"], [role="group"]');
    const t = row?.querySelector('[data-testid="episode-progress-not-played"]')?.textContent;
    return t ? lib.parseHumanDuration(t) : null;
  }

  async function renderRows() {
    if (!lib || !W.settings?.badges) return;
    const list = episodeLinks();
    if (!list.length) return;
    const cards = await W.cards(list.map((x) => `sp:${x.id}`));
    const unknown = list.filter((x) => !cards[`sp:${x.id}`]).map((x) => ({ key: `sp:${x.id}`, p: 'sp', id: x.id, title: x.a.textContent.trim(), dur: rowLength(x.a) }));
    const matched = unknown.length ? await W.match(unknown) : {};
    for (const { a, id } of list) W.paintChip(a, W.describe(lib, cards[`sp:${id}`] || matched[`sp:${id}`], 'sp'));
  }

  let bannerFor = null;
  async function renderBanner() {
    if (!lib || !W.settings?.badges) return;
    const id = epId(location.pathname);
    const bar = document.querySelector('[data-testid="action-bar-row"]');
    if (!id || !bar?.parentElement) return;
    let card = (await W.cards([`sp:${id}`]))[`sp:${id}`];
    if (!card && bannerFor !== id) {
      bannerFor = id;
      card = (await W.ask({ t: 'card', ref: `sp:${id}` }))?.card || null;
    }
    if (!card) {
      const title = document.querySelector('[data-testid="episodeTitle"]')?.textContent?.trim() || '';
      const len = document.querySelector('[data-testid="action-bar-row"] [data-testid="episode-progress-not-played"], [data-testid="episode-progress-not-played"]')?.textContent;
      card = (await W.match([{ key: `sp:${id}`, p: 'sp', id, title, dur: len ? lib.parseHumanDuration(len) : null }]))[`sp:${id}`] || null;
    }
    const d = W.describe(lib, card, 'sp');
    const host = bar.parentElement;
    if (!d) return host.querySelector(':scope > .trove-banner')?.remove();
    const actions = [];
    if (d.resume && d.kind === 'part') {
      actions.push({
        label: `Play from ${d.resume.exact ? '' : '≈'}${lib.clock(d.resume.pos)}`,
        primary: true,
        run: () => {
          if (session?.id === id) window.postMessage({ __trove: 'sp-seek', t: d.resume.pos }, location.origin);
          else {
            pendingSeek = { id, pos: d.resume.pos };
            bar.querySelector('[data-testid="play-button"]')?.click();
          }
        },
      });
    }
    if (card?.id) actions.push(d.kind === 'done' ? { label: 'Not finished', run: (b) => mark(card.id, 'unfinished', b) } : { label: 'Mark finished', run: (b) => mark(card.id, 'finished', b) });
    document.documentElement.classList.add('trove-dark');
    W.paintBanner(host, bar.nextSibling, d, actions);
  }

  async function mark(id, status, button) {
    button.disabled = true;
    button.textContent = 'Saving…';
    const r = await W.ask({ t: 'mark', id, patch: { status } });
    if (!r?.card) button.textContent = r?.error ? 'Failed' : 'Offline';
    else if (status === 'unfinished' && session && r.card.sp?.id === session.id) session.reset();
  }

  W.ready.then(async () => {
    lib = await W.lib;
    W.css();
    startOrSwitch();
    W.watchDom(() => {
      renderRows();
      renderBanner();
    });
  });
})();
