// Shared by the YouTube and Spotify page scripts (content scripts, isolated world): the connection to
// Trove's service worker, the play session that turns player samples into progress, and the badges.
(() => {
  if (globalThis.TroveWatch) return;
  const W = (globalThis.TroveWatch = {});

  // ---------- messaging ----------

  let port = null;
  let rid = 0;
  const waiting = new Map();
  const refreshers = new Set();

  W.alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  function connect() {
    if (port) return port;
    if (!W.alive()) return null;
    try {
      port = chrome.runtime.connect({ name: 'trove-watch' });
    } catch {
      return null;
    }
    port.onMessage.addListener((m) => {
      if (m?.rid && waiting.has(m.rid)) {
        waiting.get(m.rid)(m);
        waiting.delete(m.rid);
      } else if (m?.t === 'refresh') {
        for (const f of refreshers) {
          try {
            f();
          } catch { /* keep going */ }
        }
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
    });
    return port;
  }

  /** Fire and forget (reconnects when the service worker was asleep). */
  W.send = (msg) => {
    for (let i = 0; i < 2; i++) {
      const p = connect();
      if (!p) return false;
      try {
        p.postMessage(msg);
        return true;
      } catch {
        port = null;
      }
    }
    return false;
  };

  W.ask = (msg, timeout = 10000) =>
    new Promise((resolve) => {
      const id = ++rid;
      waiting.set(id, resolve);
      if (!W.send({ ...msg, rid: id })) {
        waiting.delete(id);
        return resolve(null);
      }
      setTimeout(() => waiting.delete(id) && resolve(null), timeout);
    });

  W.onRefresh = (f) => refreshers.add(f);

  W.lib = import(chrome.runtime.getURL('lib/progress.js'));
  W.ready = W.ask({ t: 'hello' }).then((r) => (W.settings = r?.settings || { youtube: true, spotify: true, badges: true, dim: true, connected: false }));

  // ---------- a play session ----------

  /**
   * One video or episode being played in this tab. Samples go through the Tracker (what you
   * actually heard); every few seconds, and right away on pause, end, hiding the tab or leaving,
   * the whole session so far is sent (sending it twice is harmless).
   */
  W.Session = class {
    constructor(lib, p, id, meta) {
      this.lib = lib;
      this.p = p;
      this.id = id;
      this.meta = meta;
      this.tracker = new lib.Tracker();
      this.started = Date.now();
      this.armed = false;
      this.lastSend = 0;
      this.dirty = false;
      this.pos = null;
      this.dur = null;
    }

    sample(s) {
      if (!this.armed) return;
      this.tracker.sample({ t: s.t, wall: Date.now(), rate: s.rate || 1, playing: s.playing, seeking: s.seeking });
      // Only trust the clock while the episode itself plays: an ad uses the same player, with its own length.
      if (!s.playing) return;
      if (Number.isFinite(s.dur) && s.dur > 0 && (!this.dur || s.dur > this.dur * 0.5)) this.dur = s.dur;
      if (Number.isFinite(s.t)) this.pos = s.t;
      this.dirty = true;
      if (Date.now() - this.lastSend > 5000) this.send(false);
    }

    /** Start over (after "Not finished": what was played before doesn't count again). */
    reset() {
      this.tracker = new this.lib.Tracker();
      this.started = Date.now();
      this.dirty = false;
    }

    /** Nothing is sent until something was actually played (opening a page and leaving isn't watching). */
    send(urgent) {
      if (!this.dirty && !urgent) return;
      const ranges = this.tracker.snapshot();
      const played = ranges.reduce((a, [s, e]) => a + (e - s), 0);
      if (played < 3) return;
      const meta = (typeof this.meta === 'function' ? this.meta() : this.meta) || {};
      W.send({
        t: 'progress',
        urgent,
        ev: { p: this.p, id: this.id, at: Date.now(), since: this.started, dur: this.dur ? Math.round(this.dur * 10) / 10 : undefined, pos: Math.round((this.pos || 0) * 10) / 10, ranges, src: 'extension', ...meta },
      });
      this.lastSend = Date.now();
      this.dirty = false;
    }

    end() {
      this.tracker.close();
      this.send(true);
    }
  };

  // ---------- badges ----------

  const NAME = { yt: 'YouTube', sp: 'Spotify' };

  /** What to show for a card on a page of platform `here` ('yt' | 'sp'). */
  /** Badge/banner text for a card on a `here` page; `hereDur` is the length of what's on screen (when Trove lacks it). */
  W.describe = (lib, card, here, hereDur) => {
    if (!card || card.status === 'new') return null;
    const verb = here === 'sp' ? 'Played' : 'Watched';
    if (card.status === 'finished') {
      const on = card.doneOn && !['both', 'manual', here].includes(card.doneOn) ? ` on ${NAME[card.doneOn]}` : '';
      const when = card.finishedAt ? new Date(card.finishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(card.finishedAt).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : '';
      return { kind: 'done', label: `✓ ${verb}${on}`, pct: 1, title: `Trove: finished${on}${when ? ` · ${when}` : ''}`, resume: null };
    }
    // Seen on a platform that kept no position (YouTube's history does that for some videos): no % to show.
    if (card.seen && !card.resume && (card.pct || 0) < 0.02) {
      const on = card.seen !== here ? ` on ${NAME[card.seen]}` : '';
      return { kind: 'part', label: `◐ Seen${on}`, pct: 0, title: `Trove: seen${on}, position not saved`, resume: null };
    }
    const pct = Math.max(1, Math.round((card.pct || 0) * 100));
    const r = card.resume;
    let at = '';
    let resume = null;
    if (r) {
      const mine = card[here];
      const m = r.p === here ? { pos: r.pos, exact: true } : lib.mapPosition(r.pos, r.dur || card[r.p]?.dur, mine?.dur || hereDur);
      resume = { pos: m.pos, exact: m.exact, from: r.p };
      at = `${m.exact ? '' : '≈'}${lib.clock(m.pos)}${r.p !== here ? ` on ${NAME[r.p]}` : ''}`;
    }
    return { kind: 'part', label: `◐ ${pct}%${at ? ` · ${at}` : ''}`, pct: card.pct || 0, title: `Trove: ${pct}% heard${at ? `, last at ${at}` : ''}`, resume };
  };

  W.css = () => {
    if (document.getElementById('trove-watch-css')) return;
    const st = document.createElement('style');
    st.id = 'trove-watch-css';
    st.textContent = `
      .trove-badge{position:absolute;top:6px;left:6px;z-index:30;font:600 11.5px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;letter-spacing:.01em;padding:2px 7px;border-radius:6px;color:#fff;background:rgba(15,15,15,.85);pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,.35);white-space:nowrap;max-width:calc(100% - 12px);overflow:hidden;text-overflow:ellipsis}
      .trove-badge.trove-done{background:#17824f}
      .trove-badge.trove-part{background:#9a6b00}
      .trove-bar{position:absolute;left:0;right:0;bottom:0;height:4px;z-index:30;background:rgba(255,255,255,.28);pointer-events:none}
      .trove-bar>i{display:block;height:100%;background:#8b6cff}
      .trove-dim img,.trove-dim yt-image,.trove-dim .yt-core-image{opacity:.45;transition:opacity .15s}
      .trove-dim:hover img,.trove-dim:hover yt-image,.trove-dim:hover .yt-core-image{opacity:1}
      .trove-chip{display:inline-flex;align-items:center;gap:4px;margin:0 6px;vertical-align:middle;font:600 11.5px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:1px 7px;border-radius:999px;color:#fff;white-space:nowrap}
      .trove-chip.trove-done{background:#17824f}
      .trove-chip.trove-part{background:#9a6b00}
      .trove-banner{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;margin:10px 0 4px;padding:9px 12px;border-radius:10px;font:500 13.5px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#0f0f0f;background:#efeafe;border:1px solid #d9cffc}
      .trove-banner b{font-weight:700}
      .trove-banner .trove-meter{flex:1 1 120px;max-width:220px;height:6px;border-radius:3px;background:rgba(0,0,0,.12);overflow:hidden}
      .trove-banner .trove-meter>i{display:block;height:100%;background:#7a5af8}
      .trove-banner button{font:600 12.5px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:7px 11px;border-radius:999px;border:1px solid rgba(0,0,0,.15);background:#fff;color:#0f0f0f;cursor:pointer}
      .trove-banner button.trove-primary{background:#7a5af8;border-color:#7a5af8;color:#fff}
      .trove-banner .trove-logo{font-weight:800;letter-spacing:-.01em;color:#5b3fd6}
      .trove-banner.trove-done{background:#e5f5ec;border-color:#bfe5cf}
      .trove-banner.trove-done .trove-logo{color:#17824f}
      html[dark] .trove-banner,html.trove-dark .trove-banner{color:#f1f1f1;background:#2a2340;border-color:#40355f}
      html[dark] .trove-banner.trove-done,html.trove-dark .trove-banner.trove-done{background:#173326;border-color:#24533b}
      html[dark] .trove-banner button,html.trove-dark .trove-banner button{background:#272727;color:#f1f1f1;border-color:rgba(255,255,255,.2)}
      html[dark] .trove-banner .trove-logo,html.trove-dark .trove-banner .trove-logo{color:#b6a4ff}
      html[dark] .trove-banner.trove-done .trove-logo,html.trove-dark .trove-banner.trove-done .trove-logo{color:#5fd39a}
    `;
    (document.head || document.documentElement).append(st);
  };

  /** Absolute badge + progress bar inside a thumbnail. */
  W.paintThumb = (host, d, { dim }) => {
    let badge = host.querySelector(':scope > .trove-badge');
    let bar = host.querySelector(':scope > .trove-bar');
    if (!d) {
      if (badge || bar) {
        badge?.remove();
        bar?.remove();
        host.classList.remove('trove-dim');
        delete host.dataset.trove;
      }
      return;
    }
    const sig = `${d.kind}|${d.label}|${Math.round(d.pct * 100)}|${dim ? 1 : 0}`;
    if (badge && host.dataset.trove === sig) return; // unchanged: don't touch the page
    host.dataset.trove = sig;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    if (!badge) {
      badge = document.createElement('span');
      host.append(badge);
    }
    badge.className = `trove-badge trove-${d.kind}`;
    badge.textContent = d.label;
    badge.title = d.title;
    if (d.kind === 'part') {
      if (!bar) {
        bar = document.createElement('span');
        bar.className = 'trove-bar';
        bar.append(document.createElement('i'));
        host.append(bar);
      }
      bar.firstChild.style.width = `${Math.round(d.pct * 100)}%`;
    } else bar?.remove();
    host.classList.toggle('trove-dim', !!dim && d.kind === 'done');
  };

  /** Inline chip after a title link. */
  W.paintChip = (anchor, d) => {
    let chip = anchor.nextElementSibling?.classList?.contains('trove-chip') ? anchor.nextElementSibling : null;
    if (!d) return chip?.remove();
    if (chip && chip.textContent === d.label && chip.classList.contains(`trove-${d.kind}`)) return;
    if (!chip) {
      chip = document.createElement('span');
      anchor.after(chip);
    }
    chip.className = `trove-chip trove-${d.kind}`;
    chip.textContent = d.label;
    chip.title = d.title;
  };

  /** The status bar under a video / episode title, with Resume and Mark buttons. */
  W.paintBanner = (host, before, d, actions) => {
    let el = host.querySelector(':scope > .trove-banner');
    const sig = `${d ? `${d.kind}|${d.title}|${Math.round(d.pct * 100)}` : 'none'}|${actions.map((a) => a.label).join(',')}`;
    if (el && el.dataset.sig === sig) return el;
    if (!el) {
      el = document.createElement('div');
      if (before && before.parentNode === host) host.insertBefore(el, before);
      else host.append(el);
    }
    el.className = `trove-banner trove-${d ? d.kind : 'none'}`;
    el.dataset.sig = sig;
    el.replaceChildren();
    const logo = document.createElement('span');
    logo.className = 'trove-logo';
    logo.textContent = 'Trove';
    const text = document.createElement('span');
    text.textContent = d ? d.title.replace(/^Trove: /, '') : 'Not played yet on any platform';
    el.append(logo, text);
    if (d?.kind === 'part') {
      const m = document.createElement('span');
      m.className = 'trove-meter';
      const i = document.createElement('i');
      i.style.width = `${Math.round(d.pct * 100)}%`;
      m.append(i);
      el.append(m);
    }
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      if (a.primary) b.className = 'trove-primary';
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        a.run(b);
      });
      el.append(b);
    }
    return el;
  };

  /** Ask for cards by ref, with a small cache that the service worker's refresh clears. */
  const cache = new Map();
  W.onRefresh(() => cache.clear());
  W.cards = async (refs) => {
    const need = [...new Set(refs)].filter((r) => !cache.has(r));
    if (need.length) {
      for (let i = 0; i < need.length; i += 100) {
        const r = await W.ask({ t: 'lookup', refs: need.slice(i, i + 100) });
        for (const ref of need.slice(i, i + 100)) cache.set(ref, r?.cards?.[ref] || null);
      }
    }
    return Object.fromEntries(refs.map((r) => [r, cache.get(r) || null]));
  };

  /** Cards for unknown items found by title and length on the other platform. */
  const asked = new Map();
  W.onRefresh(() => asked.clear());
  W.match = async (items) => {
    const fresh = items.filter((i) => !asked.has(i.key));
    if (fresh.length) {
      const r = await W.ask({ t: 'match', items: fresh });
      for (const i of fresh) asked.set(i.key, r?.cards?.[i.key] || null);
    }
    return Object.fromEntries(items.map((i) => [i.key, asked.get(i.key) || null]));
  };

  /** Run fn when the page changes (at most every `delay` ms, since these pages never stop mutating), and on refreshes. */
  W.watchDom = (fn, delay = 700) => {
    let t = null;
    const run = () => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        if (W.alive()) fn();
      }, delay);
    };
    new MutationObserver(run).observe(document.documentElement, { childList: true, subtree: true });
    W.onRefresh(run);
    run();
    return run;
  };
})();
