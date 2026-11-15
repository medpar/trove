#!/usr/bin/env python3
"""Screenshots of Trove for the README and the project site, from a fictional sample library.

  node scripts/screenshots/demo-server.mjs &          # fake API on :8790
  npm --prefix web run dev -- --port 3210 &           # the web app
  python3 scripts/screenshots/capture.py              # -> docs/screenshots/*.png

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
    .phone{{position:absolute;right:56px;top:150px;width:330px;border-radius:46px;padding:12px;background:#111;box-shadow:0 30px 80px rgba(0,0,0,.35)}}
    .phone img{{display:block;width:100%;border-radius:36px}}
    .pop{{position:absolute;left:800px;top:330px;width:300px;border-radius:12px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.28);border:1px solid #e7e4de}}
    .pop img{{display:block;width:100%}}
    </style>
    <div class="win"><div class="bar"><i></i><i></i><i></i><span>trove.example.com</span></div><img src="{data_uri('library')}"></div>
    <div class="pop"><img src="{data_uri('extension')}"></div>
    <div class="phone"><img src="{data_uri('mobile-shows')}"></div>"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    cookie = session_cookie()
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome', headless=True)

        def page(w=1440, h=900, dark=False, mobile=False, init=''):
            ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, is_mobile=mobile, has_touch=mobile,
                                      color_scheme='dark' if dark else 'light', reduced_motion='reduce')
            ctx.add_cookies([{'name': 'trove_session', 'value': cookie, 'url': APP}])
            ctx.route(f'{APP}/api/**', to_demo)
            ctx.route(f'{APP}/demo-cover/**', to_demo)
            ctx.route('http://127.0.0.1:7878/**', to_demo)
            ctx.add_init_script(f"""try {{
              localStorage.setItem('trove-theme', {json.dumps('dark' if dark else 'light')});
              localStorage.removeItem('trove-view');
              sessionStorage.removeItem('trove-agent');
            }} catch (e) {{}}
            {init}""")
            pg = ctx.new_page()
            return pg

        def shot(name, path, settle=1800, before=None, **kw):
            if ONLY and name not in ONLY:
                return
            pg = page(**kw)
            pg.goto(APP + path, wait_until='networkidle')
            pg.add_style_tag(content='nextjs-portal{display:none!important}')
            pg.wait_for_timeout(settle)
            if before:
                before(pg)
                pg.wait_for_timeout(900)
            pg.screenshot(path=str(OUT / f'{name}.png'))
            print('✓', name)
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
        shot('mobile-library', '/', w=390, h=844, mobile=True)
        shot('mobile-reader', '/?item=demo-1', w=390, h=844, mobile=True)
        shot('mobile-shows', '/?s=shows', w=390, h=844, mobile=True, dark=True)

        # Extension popup, from the extension's own files with a stubbed chrome.* API.
        if not ONLY or 'extension' in ONLY:
            ctx = browser.new_context(viewport={'width': 380, 'height': 640}, device_scale_factor=2, color_scheme='light')
            ext = ROOT / 'extension'
            def serve(route):
                f = ext / route.request.url.split('http://ext.trove/', 1)[1].split('?')[0]
                ct = {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml'}.get(f.suffix, 'application/octet-stream')
                route.fulfill(status=200 if f.exists() else 404, headers={'content-type': ct}, body=f.read_bytes() if f.exists() else b'')
            ctx.route('http://ext.trove/**', serve)
            ctx.add_init_script(POPUP_STUB)
            pg = ctx.new_page()
            pg.goto('http://ext.trove/ui/popup.html', wait_until='networkidle')
            pg.wait_for_timeout(800)
            h = pg.evaluate('document.documentElement.scrollHeight')
            pg.set_viewport_size({'width': 380, 'height': h})
            pg.screenshot(path=str(OUT / 'extension.png'))
            print('✓ extension')
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


if __name__ == '__main__':
    main()
