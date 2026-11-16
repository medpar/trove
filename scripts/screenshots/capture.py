#!/usr/bin/env python3
"""Screenshots of Trove for the README and the project site, from a fictional sample library.

  node scripts/screenshots/demo-server.mjs &          # fake API on :8790
  npm --prefix web run dev -- --port 3210 &           # the web app
  python3 scripts/screenshots/capture.py              # -> docs/screenshots/*.webp

The web app runs as usual, but every /api request (and the local agent bridge) is answered by the demo
server, so no real library data can appear. Uses Playwright with the installed Google Chrome.
"""
import hmac, hashlib, base64, html, json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path
from urllib.request import Request, urlopen
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs' / 'screenshots'
APP = os.environ.get('TROVE_APP', 'http://localhost:3210')
DEMO = os.environ.get('TROVE_DEMO', 'http://127.0.0.1:8790')
ONLY = set(sys.argv[1:])


def session_cookie():
    env = (ROOT / 'web' / '.env.local').read_text()
    secret = re.search(r'^TROVE_SESSION_SECRET=["\']?([^"\'\n]+)', env, re.M).group(1)
    exp = str(int(time.time() * 1000) + 864e5 * 2).split('.')[0]
    sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), exp.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return f'{exp}.{sig}'


def to_demo(route):
    req = route.request
    u = re.sub(r'^https?://[^/]+', DEMO, req.url)
    r = Request(u, data=req.post_data_buffer if req.method not in ('GET', 'HEAD') else None, method=req.method, headers={'content-type': 'application/json'})
    with urlopen(r) as res:
        route.fulfill(status=res.status, headers={k: v for k, v in res.headers.items() if k.lower() not in ('content-length', 'transfer-encoding', 'connection')}, body=res.read())



def favicon(route):
    """Real sites keep their icons; the sample library's made-up domains get a letter icon instead of a 404."""
    try:
        res = route.fetch()
        if res.ok:
            return route.fulfill(response=res)
    except Exception:
        pass
    m = re.search(r'domain=([^&]+)', route.request.url)
    domain = (m.group(1) if m else 'x').replace('%2E', '.')
    hue = int(hashlib.md5(domain.encode()).hexdigest()[:4], 16) % 360
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="hsl({hue},45%,46%)"/>'
           f'<text x="32" y="44" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700" font-size="34" fill="#fff">{domain[0].upper()}</text></svg>')
    route.fulfill(status=200, headers={'content-type': 'image/svg+xml'}, body=svg)


POPUP_STUB = r"""
const NOW = Date.now();
window.chrome = {
  runtime: {
    sendMessage: async (m) => {
      if (m.cmd === 'status') return { ok: true, hasToken: true, loggedIn: true, job: null,
        settings: { dataSourceId: 'demo', troveUrl: 'https://trove.example.com', intervalMin: 30 },
        state: { total: 1204, lastSyncAt: NOW - 6 * 60e3, lastSyncAdded: 3, lastError: null,
          backfill: { status: 'done', scanned: 1204, saved: 1204, finishedAt: NOW - 12 * 864e5 },
          recent: [
            { title: 'A thread on pricing developer tools without making people angry', url: '#', at: NOW - 6 * 60e3 },
            { title: 'Every keyboard shortcut I use in my editor, ranked', url: '#', at: NOW - 3 * 3600e3 },
            { title: 'Notes from rebuilding our onboarding in a week', url: '#', at: NOW - 26 * 3600e3 },
          ] } };
      if (m.cmd === 'lookup') return { ok: true, item: null };
      if (m.cmd === 'watchTab') return { ok: true, ref: { p: 'yt', id: 'demo' }, card: { id: 'c1', status: 'started', pct: 0.38,
        resume: { p: 'sp', pos: 1664, dur: 4380 }, yt: { id: 'y1', dur: 4410 }, sp: { id: 's1', dur: 4380 } } };
      return { ok: true };
    },
    openOptionsPage() {}, getURL: (p) => p,
  },
  tabs: { query: async () => [{ id: 1, url: 'https://www.youtube.com/watch?v=demo', title: 'Episode 112: Starting over at forty · The Dirt Road Diaries' }], create() {} },
  storage: { onChanged: { addListener() {} }, local: { get: async () => ({}) } },
};
"""


CLI = [
    ['save', 'https://inkandswitch.com/essays/local-first-revisited', '-t', 'crdt', '-n', 'for the offline talk'],
    ['search', '#sync'],
    ['ask', 'What have I saved about offline sync?'],
]


def terminal_html():
    """Runs the real trove CLI against the demo server and lays the session out as a terminal window."""
    env = {**os.environ, 'TROVE_URL': DEMO, 'TROVE_API_KEY': 'demo', 'HOME': tempfile.mkdtemp(), 'NO_COLOR': '1'}
    out = []
    for args in CLI:
        shown = ' '.join(a if re.fullmatch(r'[\w:/.\-#]+', a) and not a.startswith('#') else json.dumps(a) if ' ' in a else f"'{a}'" for a in args)
        res = subprocess.run(['node', str(ROOT / 'cli' / 'trove.mjs'), *args], capture_output=True, text=True, env=env, timeout=30)
        text = (res.stdout + res.stderr).replace(DEMO, 'https://trove.example.com').rstrip()
        text = html.escape(text)
        text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
        text = re.sub(r'(#[\w-]+)', r'<span class="tag">\1</span>', text)
        text = re.sub(r'(\[\d\])', r'<span class="ref">\1</span>', text)
        text = text.replace('✓', '<span class="ok">✓</span>')
        out.append(f'<div><span class="ps">~ $</span> <b>trove</b> {html.escape(shown)}</div><div class="o">{text}</div>')
    return f"""<!doctype html><meta charset="utf-8"><style>
    body{{margin:0;padding:28px;background:linear-gradient(135deg,#fdeee4,#f3f1ec);font:14.5px/1.6 'SF Mono',ui-monospace,Menlo,monospace}}
    .win{{background:#1b1a18;color:#e9e7e1;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.25);overflow:hidden}}
    .bar{{display:flex;gap:8px;padding:12px 14px;background:#262523}} .bar i{{width:12px;height:12px;border-radius:50%;background:#ff5f57}}
    .bar i:nth-child(2){{background:#febc2e}} .bar i:nth-child(3){{background:#28c840}} .bar span{{flex:1;text-align:center;color:#8d8a83;font-size:12.5px;margin-right:52px}}
    .body{{padding:16px 20px 22px;white-space:pre-wrap}} .ps{{color:#ff7a33}} .o{{color:#c9c6be;margin:2px 0 14px}} .tag{{color:#7cc4ff}} .ref{{color:#ff9f66}} .ok{{color:#5fd38d}} b{{color:#fff}}
    </style><div class="win"><div class="bar"><i></i><i></i><i></i><span>trove — zsh</span></div><div class="body">{''.join(out)}</div></div>"""


def data_uri(name):
    f = OUT / f'{name}.png'
    if not f.exists():
        f = f.with_suffix('.webp')
    return f'data:image/{f.suffix[1:]};base64,' + base64.b64encode(f.read_bytes()).decode()


def hero_html():
    """The library in a browser window, with the phone app and the extension popup in front."""
    return f"""<!doctype html><meta charset="utf-8"><style>
    body{{margin:0;width:1600px;height:980px;background:radial-gradient(circle at 20% 10%,#ffe3cf,#f6efe6 45%,#efe9e0);position:relative;overflow:hidden;font-family:system-ui}}
    .win{{position:absolute;left:60px;top:60px;width:1240px;border-radius:14px;overflow:hidden;box-shadow:0 30px 80px rgba(60,30,10,.25);background:#fff}}
    .bar{{height:38px;background:#f3f1ec;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid #e7e4de}}
    .bar i{{width:12px;height:12px;border-radius:50%;background:#ff5f57}} .bar i:nth-child(2){{background:#febc2e}} .bar i:nth-child(3){{background:#28c840}}
    .bar span{{margin-left:16px;flex:0 0 420px;height:24px;border-radius:7px;background:#fff;color:#888;font-size:13px;display:flex;align-items:center;padding-left:12px}}
    .win img{{display:block;width:100%}}
    .phone{{position:absolute;right:-10px;top:150px;width:470px}}
    .phone img{{display:block;width:100%}}
    .pop{{position:absolute;left:800px;top:330px;width:300px;border-radius:12px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.28);border:1px solid #e7e4de}}
    .pop img{{display:block;width:100%}}
    </style>
    <div class="win"><div class="bar"><i></i><i></i><i></i><span>trove.example.com</span></div><img src="{data_uri('library')}"></div>
    <div class="pop"><img src="{data_uri('extension')}"></div>
    <div class="phone"><img src="{data_uri('mobile-shows')}"></div>"""


# iPhone 16 Pro: 393 x 852 pt screen. The page is drawn below the status bar, as an app added to the home screen.
PHONE_W, PHONE_H, STATUS_H = 393, 852, 54

STATUS_ICONS = """
<svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="7.5" width="3" height="4.5" rx="1"/><rect x="5" y="5" width="3" height="7" rx="1"/><rect x="10" y="2.5" width="3" height="9.5" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
<svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 2.6c2.3 0 4.4.9 6 2.4l1.1-1.2A10.2 10.2 0 0 0 8 1C5.3 1 2.8 2 .9 3.8L2 5c1.6-1.5 3.7-2.4 6-2.4Zm0 3.3c1.4 0 2.6.5 3.6 1.4l1.1-1.2A6.8 6.8 0 0 0 8 4.3c-1.8 0-3.4.7-4.7 1.8l1.1 1.2c1-.9 2.2-1.4 3.6-1.4Zm0 3.3c.5 0 1 .2 1.3.5L8 11.2 6.7 9.7c.3-.3.8-.5 1.3-.5Z"/></svg>
<svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.8" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2.5"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" opacity=".45"/></svg>"""


def phone_html(screen, bg, dark):
    """A page screenshot inside an iPhone: titanium band, black bezel, Dynamic Island, status bar and home indicator."""
    ink = '#fff' if dark else '#000'
    return f"""<!doctype html><meta charset="utf-8"><style>
    html,body{{margin:0;background:transparent}}
    body{{padding:40px 70px 120px;display:inline-block;font-family:-apple-system,'SF Pro Text',system-ui,sans-serif}}
    .dev{{position:relative;width:{PHONE_W + 18}px;height:{PHONE_H + 18}px;border-radius:65px;padding:9px;box-sizing:border-box;
      background:#0b0b0c;box-shadow:0 0 0 2.5px #9c9a96,0 0 0 3.5px #5f5d5a,inset 0 0 0 1px #2a2a2c,0 40px 70px -20px rgba(40,25,10,.38),0 18px 30px -12px rgba(0,0,0,.25)}}
    .dev::before{{content:'';position:absolute;inset:-3.5px;border-radius:68.5px;pointer-events:none;
      background:linear-gradient(135deg,rgba(255,255,255,.55),rgba(255,255,255,0) 22%,rgba(255,255,255,0) 78%,rgba(255,255,255,.35));
      -webkit-mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0);padding:3.5px;box-sizing:border-box}}
    .btn{{position:absolute;width:4px;border-radius:2px;background:linear-gradient(90deg,#6d6b67,#b9b6b0 60%,#7d7b77)}}
    .l{{left:-7px}} .r{{right:-7px}}
    .screen{{position:relative;width:{PHONE_W}px;height:{PHONE_H}px;border-radius:56px;overflow:hidden;background:{bg}}}
    .screen img{{position:absolute;left:0;top:{STATUS_H}px;width:{PHONE_W}px;display:block}}
    .status{{position:absolute;inset:0 0 auto;height:{STATUS_H}px;display:flex;align-items:center;justify-content:space-between;padding:4px 30px 0 52px;box-sizing:border-box;color:{ink};background:{bg};z-index:1}}
    .time{{font-weight:600;font-size:17px;letter-spacing:-.2px;width:56px;text-align:center}}
    .icons{{display:flex;gap:6px;align-items:center;fill:currentColor}}
    .island{{position:absolute;top:11px;left:50%;transform:translateX(-50%);width:124px;height:36px;border-radius:20px;background:#000;z-index:2}}
    .home{{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);width:139px;height:5px;border-radius:3px;background:{ink};opacity:.85;z-index:2}}
    </style>
    <div class="dev">
      <i class="btn l" style="top:150px;height:34px"></i><i class="btn l" style="top:212px;height:64px"></i><i class="btn l" style="top:290px;height:64px"></i>
      <i class="btn r" style="top:250px;height:100px"></i>
      <div class="screen"><div class="status"><span class="time">9:41</span><span class="icons">{STATUS_ICONS}</span></div>
        <div class="island"></div><img src="data:image/png;base64,{base64.b64encode(screen).decode()}"><div class="home"></div></div>
    </div>"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    cookie = session_cookie()
    problems = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome', headless=True)

        def track(pg):
            pg._errors = []
            pg.on('console', lambda m: m.type == 'error' and pg._errors.append(f'console: {m.text[:200]}'))
            pg.on('pageerror', lambda e: pg._errors.append(f'page error: {e}'))
            pg.on('requestfailed', lambda r: pg._errors.append(f'failed: {r.url[:120]} ({r.failure})'))
            pg.on('response', lambda r: r.status >= 400 and pg._errors.append(f'HTTP {r.status}: {r.url[:120]}'))

        def check(pg, name):
            """Broken images and anything the page logged as an error count as a failed screenshot."""
            broken = pg.evaluate("""[...document.images].filter(i => i.complete && i.naturalWidth === 0 && i.getAttribute('src')).map(i => 'broken image: ' + i.src.slice(0, 120))""")
            errs = pg._errors + broken
            if errs:
                problems.append((name, errs))
            print('✗' if errs else '✓', name, *(f'\n    {e}' for e in errs))

        def page(w=1440, h=900, dark=False, mobile=False, init=''):
            ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, is_mobile=mobile, has_touch=mobile,
                                      color_scheme='dark' if dark else 'light', reduced_motion='reduce')
            ctx.add_cookies([{'name': 'trove_session', 'value': cookie, 'url': APP}])
            ctx.route(f'{APP}/api/**', to_demo)
            ctx.route(f'{APP}/demo-cover/**', to_demo)
            ctx.route('http://127.0.0.1:7878/**', to_demo)
            ctx.route('https://www.google.com/s2/favicons**', favicon)
            ctx.add_init_script(f"""try {{
              localStorage.setItem('trove-theme', {json.dumps('dark' if dark else 'light')});
              localStorage.removeItem('trove-view');
              sessionStorage.removeItem('trove-agent');
            }} catch (e) {{}}
            {init}""")
            pg = ctx.new_page()
            track(pg)
            return pg

        def shot(name, path, settle=1800, before=None, mobile=False, dark=False, **kw):
            if ONLY and name not in ONLY:
                return
            if mobile:
                kw.update(w=PHONE_W, h=PHONE_H - STATUS_H, mobile=True)
            pg = page(dark=dark, **kw)
            pg.goto(APP + path, wait_until='networkidle')
            pg.add_style_tag(content='nextjs-portal{display:none!important}')
            pg.wait_for_timeout(settle)
            if before:
                before(pg)
                pg.wait_for_timeout(900)
            if mobile:
                bg = pg.evaluate("getComputedStyle(document.body).backgroundColor")
                raw = pg.screenshot()
                frame = page(w=520, h=960)
                frame.set_content(phone_html(raw, bg, dark))
                frame.locator('body').screenshot(path=str(OUT / f'{name}.png'), omit_background=True)
                frame.context.close()
            else:
                pg.screenshot(path=str(OUT / f'{name}.png'))
            check(pg, name)
            pg.context.close()

        shot('library', '/')
        shot('library-dark', '/?view=list', dark=True)
        shot('moodboard', '/?s=collection:Pinterest&view=mood')
        shot('reader', '/?item=demo-1')
        shot('search', '/?q=apps%20that%20work%20offline')
        shot('ask', '/?ask=What%20have%20I%20saved%20about%20offline%20sync%3F', settle=2500)
        shot('agent', '/?agent=1', settle=2000, before=lambda pg: (pg.keyboard.type('Tag everything in Design that has no tags, and merge #ui-design into #ui'), pg.keyboard.press('Enter'), pg.wait_for_timeout(1500)))
        shot('feeds', '/?s=feeds')
        shot('shows', '/?s=shows', init="try{localStorage.setItem('trove-show-tab','continue')}catch(e){}")
        shot('show', '/?s=shows&show=sh1')
        shot('palette', '/', before=lambda pg: (pg.keyboard.press('Meta+k'), pg.keyboard.type('ask')))
        shot('settings', '/settings')
        shot('mobile-library', '/', mobile=True)
        shot('mobile-reader', '/?item=demo-1', mobile=True)
        shot('mobile-shows', '/?s=shows', mobile=True)

        # Extension popup, from the extension's own files with a stubbed chrome.* API.
        if not ONLY or 'extension' in ONLY:
            ctx = browser.new_context(viewport={'width': 380, 'height': 640}, device_scale_factor=2, color_scheme='light')
            ext = ROOT / 'extension'
            def serve(route):
                f = ext / route.request.url.split('http://ext.trove/', 1)[1].split('?')[0]
                ct = {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml'}.get(f.suffix, 'application/octet-stream')
                route.fulfill(status=200 if f.exists() else 404, headers={'content-type': ct}, body=f.read_bytes() if f.exists() else b'')
            ctx.route('http://ext.trove/**', serve)
            ctx.route('https://www.google.com/s2/favicons**', favicon)
            ctx.add_init_script(POPUP_STUB)
            pg = ctx.new_page()
            track(pg)
            pg.goto('http://ext.trove/ui/popup.html', wait_until='networkidle')
            pg.wait_for_timeout(800)
            h = pg.evaluate('document.documentElement.scrollHeight')
            pg.set_viewport_size({'width': 380, 'height': h})
            pg.screenshot(path=str(OUT / 'extension.png'))
            check(pg, 'extension')
            ctx.close()

        if not ONLY or 'cli' in ONLY:
            ctx = browser.new_context(viewport={'width': 1240, 'height': 400}, device_scale_factor=2)
            pg = ctx.new_page()
            pg.set_content(terminal_html())
            h = pg.evaluate('document.documentElement.scrollHeight')
            pg.set_viewport_size({'width': 1240, 'height': h})
            pg.screenshot(path=str(OUT / 'cli.png'))
            print('✓ cli')
            ctx.close()

        if not ONLY or 'hero' in ONLY:
            ctx = browser.new_context(viewport={'width': 1600, 'height': 980}, device_scale_factor=1.5)
            pg = ctx.new_page()
            pg.set_content(hero_html())
            pg.wait_for_timeout(300)
            pg.screenshot(path=str(OUT / 'hero.png'))
            print('✓ hero')
            ctx.close()

        browser.close()

    # WebP is about a tenth of the PNG size and renders on GitHub and in every current browser.
    if shutil.which('cwebp'):
        for png in OUT.glob('*.png'):
            subprocess.run(['cwebp', '-quiet', '-q', '86', '-m', '6', str(png), '-o', str(png.with_suffix('.webp'))], check=True)
            png.unlink()
    if problems:
        sys.exit(f'{len(problems)} screenshot(s) had errors: ' + ', '.join(n for n, _ in problems))


if __name__ == '__main__':
    main()
