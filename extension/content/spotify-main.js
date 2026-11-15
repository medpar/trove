// open.spotify.com, page world, before the player loads: the web player plays through media elements
// it never adds to the page, so catch them when they are created and report their clock to Trove's
// content script (which can't see them). Also lets Trove seek ("Resume at 23:14").
(() => {
  if (window.__troveSpotifyMain) return;
  window.__troveSpotifyMain = true;
  const seen = new WeakSet();
  let current = null;

  function report(el, type) {
    if (type === 'play' || type === 'playing' || (!el.paused && type === 'time')) current = el;
    if (el !== current) return;
    window.postMessage({ __trove: 'sp-media', type, t: el.currentTime, d: el.duration, paused: el.paused, ended: el.ended, seeking: el.seeking, rate: el.playbackRate }, location.origin);
  }

  function watch(el) {
    if (!el || seen.has(el)) return;
    seen.add(el);
    let last = 0;
    el.addEventListener('timeupdate', () => {
      const now = performance.now();
      if (now - last < 900) return;
      last = now;
      report(el, 'time');
    });
    for (const type of ['play', 'playing', 'pause', 'seeking', 'seeked', 'ratechange', 'ended', 'loadedmetadata', 'emptied']) el.addEventListener(type, () => report(el, type));
  }

  const create = Document.prototype.createElement;
  Document.prototype.createElement = function (tag, ...rest) {
    const el = create.call(this, tag, ...rest);
    if (typeof tag === 'string' && /^(audio|video)$/i.test(tag)) watch(el);
    return el;
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    watch(this);
    return play.apply(this, args);
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__trove !== 'sp-seek' || !current || !Number.isFinite(e.data.t)) return;
    current.currentTime = Math.max(0, e.data.t);
  });
})();
