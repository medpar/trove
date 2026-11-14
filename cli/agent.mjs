// Trove agent: an AI librarian that searches, classifies and tidies your library.
// It runs on your own machine with the Claude Code or Codex CLI you are already signed in to
// (Claude Pro/Max or ChatGPT subscription login, no API keys), and acts only through the `trove` CLI.

import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HOME = join(homedir(), '.config', 'trove', 'agent');
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'trove.mjs');
export const PORT = 7878;

export function instructions(troveUrl) {
  return `You are the Trove librarian. Trove is the user's personal library of saved links, articles, videos, social posts, repos, papers and notes. Each item has a title, URL, type, collection (nested with "/"), tags, note, favorite and read flags, highlights and an archived copy of the content.

You work on the library ONLY through the \`trove\` command (run it in the shell, one command per call, no pipes, no other programs). Add --json whenever you read data.

  trove search [query] --json [-l N] [--unsorted] [--untagged] [-c Collection] [--sort newest|oldest|title]
      query syntax: words "phrase" -word #tag -#tag type:video type:x (X bookmarks) site:github.com is:fav is:unread created:>2025-01 collection:"Dev/AI" match:OR
  trove get <id> --json [--content]        full item; --content adds the archived Markdown
  trove tags --json | trove collections --json
  trove update <id> [<id>…] [--title …] [--tags a,b] [--add-tags a,b] [--remove-tags a] [-c Collection | --unsorted] [-n note] [--fav|--unfav] [--read|--unread] --json
  trove rename tag <old> <new> | trove rename collection <old> <new>   (merges when <new> exists)
  trove save <url|text> [-t tags] [-c Collection] [-n note] --json
  trove check <url> --json
  trove rm <id>

How to work:
- Answer questions by searching first. Refer to items as Markdown links: [Title](${troveUrl}/?item=<id>).
- Classifying: read the existing tags and collections first and reuse them. Tags are short, lowercase, 1–3 words. Only create a new tag or collection when nothing fits (nest it under an existing parent when that makes sense). Prefer 1–4 tags per item.
- Saving: always file what you save in the same command: the best collection (-c), 1–4 tags (-t) and, when the user gave context, a one-line note (-n). Never file things into "Browser bookmarks", "X bookmarks", "Pinterest" or "GitHub stars"; Trove fills those by itself.
- Write every collection name, tag, note and title you create in English, even when the content or the request is in another language. Leave the original titles of saved pages alone unless asked to rename them.
- When asked to organize, tag, move or fix items, make the changes directly, in batches of up to 25 ids per update command. For more than 100 items, do the first 100 and say how many are left.
- Never delete items unless the user explicitly asks you to delete.
- Finish with a short summary of what you found or changed (counts and a few examples). Be concise and reply in the user's language.`;
}

// ---------- engines ----------

function shimDir() {
  // A `trove` shim on PATH so the engine's shell can call the CLI by name.
  const bin = join(HOME, 'bin');
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, 'trove');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(shim, 0o755);
  return bin;
}

const env = () => ({ ...process.env, PATH: `${shimDir()}:${process.env.PATH || ''}`, TROVE_AGENT: '1' });

let enginesCache = null;

/** Which engines are installed and signed in (cached for a minute; the checks spawn both CLIs). */
export async function engines({ fresh = false } = {}) {
  if (!fresh && enginesCache && Date.now() - enginesCache.at < 60000) return enginesCache.value;
  const claude = run('claude', ['auth', 'status'], { timeout: 20000 }).then(
    ({ stdout }) => ({ installed: true, loggedIn: !!JSON.parse(stdout).loggedIn }),
    (e) => {
      let loggedIn = false;
      try {
        loggedIn = !!JSON.parse(e.stdout || '{}').loggedIn;
      } catch { /* not JSON */ }
      return { installed: e.code !== 'ENOENT', loggedIn };
    },
  );
  const codex = run('codex', ['login', 'status'], { timeout: 20000 }).then(
    ({ stdout, stderr }) => ({ installed: true, loggedIn: /logged in/i.test(stdout + stderr) && !/not logged in/i.test(stdout + stderr) }),
    (e) => ({ installed: e.code !== 'ENOENT', loggedIn: false }),
  );
  const value = { claude: await claude, codex: await codex };
  enginesCache = { at: Date.now(), value };
  return value;
}

function claudeArgs(prompt, { session, model, troveUrl }) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--tools', 'Bash', '--allowedTools', 'Bash(trove:*)', 'Bash(trove *)', '--strict-mcp-config', '--append-system-prompt', instructions(troveUrl)];
  if (session) args.push('--resume', session);
  if (model) args.push('--model', model);
  return args;
}

function codexArgs(prompt, { session, model, troveUrl }) {
  const common = ['--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true', '-c', 'approval_policy="never"'];
  if (model) common.push('-m', model);
  if (session) return ['exec', 'resume', ...common, session, prompt];
  return ['exec', ...common, `${instructions(troveUrl)}\n\n---\n\nUser request:\n${prompt}`];
}

const short = (cmd = '') =>
  String(cmd)
    .replace(/^(\/\S+\/)?(ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\3$/, '$4')
    .replace(/\s+--json\b/g, '')
    .trim()
    .slice(0, 160);

/** Normalize one JSON line from either engine into Trove agent events. */
function translate(engine, msg, emit) {
  if (engine === 'claude') {
    if (msg.type === 'system' && msg.subtype === 'init') emit({ type: 'session', id: msg.session_id });
    else if (msg.type === 'assistant') {
      for (const c of msg.message?.content || []) {
        if (c.type === 'text' && c.text?.trim()) emit({ type: 'text', text: c.text });
        else if (c.type === 'tool_use') emit({ type: 'tool', label: short(c.input?.command || c.name) });
      }
    } else if (msg.type === 'result') {
      if (msg.is_error || msg.subtype !== 'success') emit({ type: 'error', message: authHint('claude', msg.result || msg.terminal_reason || 'The agent stopped with an error.') });
      emit({ type: 'done', session: msg.session_id });
    }
    return;
  }
  // codex exec --json
  if (msg.type === 'thread.started') emit({ type: 'session', id: msg.thread_id });
  else if (msg.type === 'item.started' && msg.item?.type === 'command_execution') emit({ type: 'tool', label: short(msg.item.command) });
  else if (msg.type === 'item.completed' && msg.item?.type === 'agent_message' && msg.item.text?.trim()) emit({ type: 'text', text: msg.item.text });
  else if (msg.type === 'turn.failed') emit({ type: 'error', message: authHint('codex', msg.error?.message || 'The agent stopped with an error.') });
  else if (msg.type === 'error') {
    if (/^reconnecting/i.test(msg.message || '')) emit({ type: 'status', text: msg.message });
    else emit({ type: 'error', message: authHint('codex', msg.message || 'Codex error') });
  }
}

const authHint = (engine, m) =>
  /401|unauthori[sz]ed|not logged in|log ?in|credential|invalid api key|oauth/i.test(m) ? `${m}\nSign in again with your subscription: ${engine === 'codex' ? 'codex login' : 'claude auth login'}` : m;

/**
 * Run one agent turn. Calls onEvent with {type:'session'|'text'|'tool'|'status'|'error'|'done'}.
 * Returns {stop} so callers can cancel.
 */
export function runAgent({ prompt, engine = 'claude', session, model, troveUrl }, onEvent) {
  mkdirSync(HOME, { recursive: true });
  const bin = engine === 'codex' ? 'codex' : 'claude';
  const args = engine === 'codex' ? codexArgs(prompt, { session, model, troveUrl }) : claudeArgs(prompt, { session, model, troveUrl });
  const child = spawn(bin, args, { cwd: HOME, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  let errText = '';
  let finished = false;
  let failed = false;
  const emit = (e) => {
    if (finished) return;
    if (e.type === 'error') failed = true;
    if (e.type === 'done') finished = true;
    onEvent(e);
  };
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try {
        translate(engine, JSON.parse(line), emit);
      } catch { /* partial or non-JSON line */ }
    }
  });
  child.stderr.on('data', (d) => (errText += d).length > 8000 && (errText = errText.slice(-8000)));
  child.on('error', (e) => {
    emit({ type: 'error', message: e.code === 'ENOENT' ? `${bin} is not installed on this computer.` : e.message });
    emit({ type: 'done' });
  });
  child.on('close', (code) => {
    if (!finished) {
      if (code && !failed) {
        emit({ type: 'error', message: authHint(engine, `${bin} exited with code ${code}.${errText ? `\n${errText.trim().split('\n').slice(-4).join('\n')}` : ''}`) });
      }
      emit({ type: 'done' });
    }
  });
  return { stop: () => child.kill('SIGTERM') };
}

// ---------- local bridge for the web app ----------

export function serve({ port = PORT, troveUrl, origins = [] }) {
  const allowed = new Set([new URL(troveUrl).origin, 'http://localhost:3000', 'http://127.0.0.1:3000', ...origins]);
  let current = null;
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const host = req.headers.host || '';
    // Only answer requests addressed to this machine (no DNS rebinding) and from Trove itself.
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}$`).test(host) || (origin && !allowed.has(origin))) {
      res.writeHead(403).end();
      return;
    }
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-private-network', 'true');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, app: 'trove-agent', busy: !!current, engines: await engines({ fresh: url.searchParams.has('fresh') }) }));
    }
    if (req.method === 'POST' && url.pathname === '/stop') {
      current?.stop();
      return res.writeHead(204).end();
    }
    if (req.method === 'POST' && url.pathname === '/run') {
      if (!/application\/json/.test(req.headers['content-type'] || '')) return res.writeHead(415).end();
      let body = '';
      for await (const c of req) body += c;
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        return res.writeHead(400).end();
      }
      if (!input.prompt?.trim()) return res.writeHead(400).end();
      if (current) {
        res.writeHead(409, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'The agent is busy with another request.' }));
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      const write = (e) => res.write(JSON.stringify(e) + '\n');
      current = runAgent({ prompt: input.prompt, engine: input.engine === 'codex' ? 'codex' : 'claude', session: input.session, model: input.model, troveUrl }, (e) => {
        write(e);
        if (e.type === 'done') {
          current = null;
          res.end();
        }
      });
      req.on('close', () => {
        if (!res.writableEnded) current?.stop();
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '127.0.0.1');
  engines().catch(() => {});
  return server;
}

// ---------- start at login (macOS) ----------

const LABEL = 'com.trove.agent';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

export async function install() {
  if (process.platform !== 'darwin') throw new Error('Auto-start is set up for macOS. On other systems, run `trove agent serve` from your startup scripts.');
  mkdirSync(HOME, { recursive: true });
  const which = async (b) => (await run('/bin/sh', ['-lc', `command -v ${b}`]).catch(() => ({ stdout: '' }))).stdout.trim();
  const dirs = new Set([dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']);
  for (const b of ['claude', 'codex']) {
    const p = await which(b);
    if (p) dirs.add(dirname(p));
  }
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  writeFileSync(
    PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(CLI)}</string><string>agent</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc([...dirs].join(':'))}</string><key>HOME</key><string>${esc(homedir())}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(join(HOME, 'agent.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(HOME, 'agent.log'))}</string>
</dict></plist>
`,
  );
  const uid = process.getuid();
  await run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]).catch(() => {});
  await run('launchctl', ['bootstrap', `gui/${uid}`, PLIST]);
  return PLIST;
}

export async function uninstall() {
  if (!existsSync(PLIST)) return false;
  await run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]).catch(() => {});
  rmSync(PLIST);
  return true;
}
