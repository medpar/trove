// youtube.com: track what you actually watch (seeks and ads don't count, closing the tab loses
// nothing) and mark every video you've started or finished, on YouTube or as a Spotify episode.
(() => {
  const W = globalThis.TroveWatch;
  if (!W || globalThis.__troveYouTube) return;
  globalThis.__troveYouTube = true;

  let lib = null;
  let session = null;
  let video = null;
  let lastHref = location.href;

  const idFrom = (href) => /[?&]v=([\w-]{11})/.exec(href || '')?.[1] || null;
  const isAd = () => !!document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting');
  // The video's own length: while an ad plays, the player reports the ad's.
  const length = () => (video && !isAd() && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null);
  const flexy = () => document.querySelector('ytd-watch-flexy');

  /** The video in the main player (also while it plays in the miniplayer). */
  function currentId() {
    if (location.pathname === '/watch') return idFrom(location.href);
    if (location.pathname.startsWith('/shorts/') || !video || video.paused) return null;
    return flexy()?.getAttribute('video-id') || null;
  }

  function meta(id) {
    const f = flexy();
    if (f?.getAttribute('video-id') !== id) return {};
    const title = document.querySelector('ytd-watch-metadata #title h1, ytd-watch-metadata h1')?.textContent?.trim();
    const ch = document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a');
    return { title: title || undefined, channel: ch?.textContent?.trim() || undefined };
  }

  // ---------- tracking ----------

  function state() {
    if (!video) return null;
    const live = !Number.isFinite(video.duration);
    return { t: video.currentTime, dur: live ? null : video.duration, playing: !video.paused && !video.ended && !isAd() && !live, seeking: video.seeking, rate: video.playbackRate };
  }

  function startOrSwitch() {
    if (!lib || !W.settings?.youtube) return;
    const id = currentId();
    if (session && session.id === id) return;
    if (session) session.end();
    session = null;
    if (!id) return;
    session = new W.Session(lib, 'yt', id, () => meta(id));
    // Wait for the new video to load before trusting the clock (the old one can play for a moment).
    setTimeout(() => {
      if (session?.id === id) session.armed = true;
    }, 1500);
  }

  let lastTick = 0;
  function tick(force = false) {
    const now = Date.now();
    if (!force && now - lastTick < 900) return;
    lastTick = now;
    startOrSwitch();
    const s = state();
    if (session && s) session.sample(s);
  }

  const onPause = () => {
    tick(true);
    session?.send(true);
  };
  const onSeek = () => tick(true);
  const onTime = () => tick();
  const onLoaded = () => {
    if (session) session.armed = true;
  };
  // An ad ending changes what the player reports as the length: map the resume point again.
  let redraw = null;
  const onLength = () => redraw?.();

  function bind() {
    const v = document.querySelector('#movie_player video.html5-main-video, video.html5-main-video');
    if (v === video) return;
    if (video) {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('durationchange', onLength);
      for (const e of ['pause', 'ended']) video.removeEventListener(e, onPause);
      for (const e of ['seeking', 'seeked', 'play', 'ratechange']) video.removeEventListener(e, onSeek);
    }
    video = v;
    if (!video) return;
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('durationchange', onLength);
    for (const e of ['pause', 'ended']) video.addEventListener(e, onPause);
    for (const e of ['seeking', 'seeked', 'play', 'ratechange']) video.addEventListener(e, onSeek);
  }

  setInterval(() => {
    if (!W.alive()) return;
    bind();
    if (location.href !== lastHref) {
      lastHref = location.href;
      startOrSwitch();
    }
    tick();
  }, 1000);
  document.addEventListener('yt-navigate-finish', () => {
    bind();
    startOrSwitch();
    renderBanner();
  });
  document.addEventListener('visibilitychange', () => document.hidden && session?.send(true));
  window.addEventListener('pagehide', () => session?.end());

  // ---------- marks ----------

  const RENDERERS = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, yt-lockup-view-model, ytd-rich-grid-media, ytd-reel-item-renderer';

  function thumbs() {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/watch?v="]')) {
      // Not the player's own end screens, nor chapter links into the video you're watching.
      if (a.closest('#movie_player, .ytp-ce-element, .ytp-endscreen-content, ytd-miniplayer, ytd-macro-markers-list-item-renderer, ytd-engagement-panel-section-list-renderer')) continue;
      if (!a.querySelector('img, yt-image, yt-thumbnail-view-model, ytd-thumbnail')) continue;
      const id = idFrom(a.getAttribute('href'));
      if (id) out.push({ a, id });
    }
    return out;
  }

  function titleAndLength(a) {
    const box = a.closest(RENDERERS) || a.parentElement;
    const title = (box?.querySelector('#video-title, .yt-lockup-metadata-view-model__title, .yt-lockup-metadata-view-model-wiz__title, h3')?.textContent || a.getAttribute('title') || '').trim();
    const len = [...a.querySelectorAll('badge-shape, .badge-shape-wiz__text, .yt-badge-shape__text, ytd-thumbnail-overlay-time-status-renderer, #time-status')]
      .map((e) => e.textContent.trim())
      .find((t) => /^\d+(:\d{2}){1,2}$/.test(t));
    return { title, dur: len ? lib.parseClock(len) : null };
  }

  async function renderThumbs() {
    if (!lib || !W.settings?.badges) return;
    const list = thumbs();
    if (!list.length) return;
    const cards = await W.cards(list.map((x) => `yt:${x.id}`));
    const unknown = list.filter((x) => !cards[`yt:${x.id}`]).map((x) => ({ key: `yt:${x.id}`, p: 'yt', id: x.id, ...titleAndLength(x.a) })).filter((x) => x.title);
    const matched = unknown.length ? await W.match(unknown) : {};
    for (const { a, id } of list) {
      const card = cards[`yt:${id}`] || matched[`yt:${id}`];
      const len = card?.resume && card.resume.p !== 'yt' && !card.yt?.dur ? titleAndLength(a).dur : null;
      W.paintThumb(a, W.describe(lib, card, 'yt', len), { dim: W.settings.dim });
    }
  }

  // ---------- the watch page ----------

  let bannerFor = null;
  async function renderBanner() {
    if (!lib || location.pathname !== '/watch' || !W.settings?.badges) return;
    const id = idFrom(location.href);
    const host = document.querySelector('ytd-watch-metadata');
    const title = host?.querySelector('#title');
    if (!id || !host || !title) return;
    let card = (await W.cards([`yt:${id}`]))[`yt:${id}`];
    if (!card && bannerFor !== id) {
      // Maybe heard on the phone and not pulled yet: ask Trove directly once.
      bannerFor = id;
      card = (await W.ask({ t: 'card', ref: `yt:${id}` }))?.card || null;
    }
    if (!card) {
      const known = (await W.match([{ key: `yt:${id}`, p: 'yt', id, title: meta(id).title || '', dur: length() }]))[`yt:${id}`];
      card = known || null;
    }
    const d = W.describe(lib, card, 'yt', length());
    const parent = title.parentElement;
    const existing = parent.querySelector(':scope > .trove-banner');
    if (!d) return existing?.remove();
    const actions = [];
    if (d.resume && d.kind === 'part' && video && Math.abs(video.currentTime - d.resume.pos) > 20) {
      actions.push({ label: `Resume at ${d.resume.exact ? '' : '≈'}${lib.clock(d.resume.pos)}`, primary: true, run: () => (video.currentTime = d.resume.pos, video.play().catch(() => {})) });
    }
    if (card?.id) {
      actions.push(
        d.kind === 'done'
          ? { label: 'Not finished', run: (b) => mark(card.id, 'unfinished', b) }
          : { label: 'Mark finished', run: (b) => mark(card.id, 'finished', b) },
      );
    }
    W.paintBanner(parent, title.nextSibling, d, actions);
  }

  async function mark(id, status, button) {
    button.disabled = true;
    button.textContent = 'Saving…';
    const r = await W.ask({ t: 'mark', id, patch: { status } });
    if (!r?.card) {
      button.textContent = r?.error ? 'Failed' : 'Offline';
      return;
    }
    if (status === 'unfinished' && session && (r.card.yt?.id === session.id)) session.reset();
    renderBanner();
  }

  W.ready.then(async () => {
    lib = await W.lib;
    W.css();
    bind();
    startOrSwitch();
    redraw = W.watchDom(() => {
      renderThumbs();
      renderBanner();
    });
  });
})();
