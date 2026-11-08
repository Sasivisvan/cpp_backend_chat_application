#!/usr/bin/env node
// Pocket IDE server: serves the mobile UI, a sandboxed file API and real
// PTY terminals (bash, Claude Code CLI, anything you can run on a PC).
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Works both as server.js and as the prebuilt bundle in dist/server.mjs.
const HERE = existsSync(path.join(__dirname, 'public')) ? __dirname : path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(HERE, 'public');
const PTY_HELPER = path.join(HERE, 'pty-helper.py');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.resolve(process.env.WORKSPACE || path.join(os.homedir(), 'projects'));
const TOKEN = process.env.IDE_TOKEN || crypto.randomBytes(16).toString('hex');
const SHELL = process.env.IDE_SHELL || process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
const MAX_FILE = 5 * 1024 * 1024;
const SCROLLBACK = 200 * 1024;

if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true });

// ---------- helpers ----------
function safePath(rel = '') {
  const p = path.resolve(ROOT, '.' + path.sep + String(rel));
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) {
    const err = new Error('Path outside workspace');
    err.status = 400;
    throw err;
  }
  return p;
}
const relPath = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

function hasCommand(cmd) {
  try {
    execSync(os.platform() === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, { stdio: 'ignore', shell: SHELL });
    return true;
  } catch { return false; }
}

function checkToken(t) {
  if (typeof t !== 'string' || t.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}

// ---------- http ----------
const app = express();
app.disable('x-powered-by');
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
app.use('/api', (req, res, next) => {
  if (checkToken(req.get('x-ide-token') || req.query.token)) return next();
  res.status(401).json({ error: 'Unauthorized: open the URL with ?token=… printed by the server' });
});
app.use('/api', express.json({ limit: '10mb' }));
app.use('/api', express.text({ limit: '10mb', type: 'text/*' }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  res.status(e.status || (e.code === 'ENOENT' ? 404 : 500)).json({ error: e.message });
});

app.get('/api/info', wrap(async (req, res) => {
  res.json({
    root: ROOT,
    name: path.basename(ROOT),
    shell: SHELL,
    platform: os.platform(),
    claude: hasCommand('claude'),
    git: hasCommand('git'),
    node: process.version,
  });
}));

app.get('/api/tree', wrap(async (req, res) => {
  const dir = safePath(req.query.path);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = entries
    .filter((e) => req.query.hidden === '1' || !['.git', 'node_modules'].includes(e.name))
    .map((e) => ({
      name: e.name,
      path: relPath(path.join(dir, e.name)),
      type: e.isDirectory() ? 'dir' : 'file',
    }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  res.json({ path: relPath(dir), entries: out });
}));

app.get('/api/file', wrap(async (req, res) => {
  const file = safePath(req.query.path);
  const st = await fs.stat(file);
  if (st.isDirectory()) return res.status(400).json({ error: 'Is a directory' });
  if (st.size > MAX_FILE) return res.status(413).json({ error: 'File too large to edit (>5MB)' });
  const buf = await fs.readFile(file);
  if (buf.subarray(0, 8000).includes(0)) return res.status(415).json({ error: 'Binary file' });
  res.type('text/plain').send(buf.toString('utf8'));
}));

app.put('/api/file', wrap(async (req, res) => {
  const file = safePath(req.query.path);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = typeof req.body === 'string' ? req.body : (req.body?.content ?? '');
  await fs.writeFile(file, body, 'utf8');
  res.json({ ok: true, path: relPath(file) });
}));

app.post('/api/mkdir', wrap(async (req, res) => {
  const dir = safePath(req.body.path);
  await fs.mkdir(dir, { recursive: true });
  res.json({ ok: true, path: relPath(dir) });
}));

app.post('/api/rename', wrap(async (req, res) => {
  const from = safePath(req.body.from);
  const to = safePath(req.body.to);
  if (from === ROOT) return res.status(400).json({ error: 'Cannot rename workspace root' });
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
  res.json({ ok: true, path: relPath(to) });
}));

app.delete('/api/file', wrap(async (req, res) => {
  const target = safePath(req.query.path);
  if (target === ROOT) return res.status(400).json({ error: 'Cannot delete workspace root' });
  await fs.rm(target, { recursive: true, force: true });
  res.json({ ok: true });
}));

// ---------- phone bridge proxy ----------
// The bridge runs in native Termux; the IDE (inside proot Ubuntu) forwards to it
// so the Automations tab can list/cancel geofences and reminders.
const BRIDGE = process.env.PHONE_BRIDGE_URL || 'http://127.0.0.1:8788';
const BRIDGE_TOKEN_FILE = process.env.PHONE_BRIDGE_TOKEN_FILE || path.join(process.env.POCKET_IDE_HOME || path.join(os.homedir(), '.pocket-ide'), 'token');
app.all('/api/phone/*', wrap(async (req, res) => {
  let token = '';
  try { token = (await fs.readFile(BRIDGE_TOKEN_FILE, 'utf8')).trim(); } catch {}
  const route = req.path.replace(/^\/api\/phone/, '');
  let r;
  try {
    r = await fetch(BRIDGE + route, {
      method: req.method,
      headers: { 'x-bridge-token': token, 'content-type': 'application/json' },
      body: ['POST', 'PUT'].includes(req.method) ? JSON.stringify(req.body || {}) : undefined,
      signal: AbortSignal.timeout(65000),
    });
  } catch {
    return res.status(503).json({ error: 'Phone bridge not running. In Termux run: pocket-bridge' });
  }
  res.status(r.status).type('application/json').send(await r.text());
}));

// ---------- terminals ----------
// Terminals use the native node-pty addon when it's installed, otherwise a tiny
// Python helper (pty-helper.py). The helper needs no compilation, which matters
// on Android/proot where building native npm modules is unreliable.
let nodePty = null;
if (process.env.IDE_PTY !== 'python') {
  try { nodePty = (await import('node-pty')).default; } catch { /* use the Python helper */ }
}
const PYTHON = process.env.IDE_PYTHON || (hasCommand('python3') ? 'python3' : 'python');

function spawnPty(file, args, { cols, rows, cwd, env }) {
  if (nodePty) return nodePty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
  const child = spawn(PYTHON, [PTY_HELPER, file, ...args], {
    cwd, env: { ...env, PTY_COLS: String(cols), PTY_ROWS: String(rows) },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  const decoder = new StringDecoder('utf8');
  const dataCbs = [];
  const exitCbs = [];
  const emit = (buf) => { const t = decoder.write(buf); if (t) dataCbs.forEach((cb) => cb(t)); };
  child.stdout.on('data', emit);
  child.stderr.on('data', emit);
  child.on('error', (e) => dataCbs.forEach((cb) => cb(`\r\n\x1b[31mCould not start ${PYTHON}: ${e.message}\x1b[0m\r\n`)));
  child.on('exit', (code, signal) => exitCbs.forEach((cb) => cb({ exitCode: code ?? (signal ? 128 : 1) })));
  return {
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    write: (d) => { if (child.stdin.writable) child.stdin.write(d); },
    resize: (c, r) => { if (child.stdio[3]?.writable) child.stdio[3].write(`${r} ${c}\n`); },
    kill: () => { try { child.kill('SIGTERM'); } catch {} },
  };
}

// Sessions outlive the websocket so a phone that sleeps / switches apps can
// reconnect and get its scrollback replayed.
const sessions = new Map();

function createSession({ kind, cwd, cols, rows }) {
  const id = crypto.randomBytes(6).toString('hex');
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', POCKET_IDE: '1' };
  let args = [];
  if (kind === 'claude' && os.platform() !== 'win32') {
    const s = JSON.stringify(SHELL);
    args = ['-lc',
      'if command -v claude >/dev/null 2>&1; then claude; else ' +
      'printf "\\033[33mClaude Code is not installed.\\033[0m\\r\\nInstall it with:  npm install -g @anthropic-ai/claude-code\\r\\n\\r\\n"; fi; ' +
      `exec ${s} -l`];
  } else if (os.platform() !== 'win32') {
    args = ['-l'];
  }
  const p = spawnPty(SHELL, args, {
    cols: Math.max(10, cols || 80),
    rows: Math.max(5, rows || 24),
    cwd,
    env,
  });
  const s = { id, kind, cwd: relPath(cwd), pty: p, buffer: '', clients: new Set(), exited: false, created: Date.now() };
  p.onData((d) => {
    s.buffer += d;
    if (s.buffer.length > SCROLLBACK) s.buffer = s.buffer.slice(-SCROLLBACK);
    for (const ws of s.clients) if (ws.readyState === 1) ws.send(d);
  });
  p.onExit(({ exitCode }) => {
    s.exited = true;
    const msg = `\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`;
    for (const ws of s.clients) if (ws.readyState === 1) { ws.send(msg); ws.close(4000, 'exited'); }
    sessions.delete(id);
  });
  sessions.set(id, s);
  return s;
}

app.get('/api/sessions', (req, res) => {
  res.json([...sessions.values()].map(({ id, kind, cwd, created }) => ({ id, kind, cwd, created })));
});
app.delete('/api/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (s) { try { s.pty.kill(); } catch {} sessions.delete(s.id); }
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/pty' || !checkToken(url.searchParams.get('token'))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
});

wss.on('connection', (ws, url) => {
  const q = url.searchParams;
  let s = q.get('id') && sessions.get(q.get('id'));
  let cwd;
  try { cwd = safePath(q.get('cwd') || ''); } catch { cwd = ROOT; }
  if (!s) {
    try {
      s = createSession({ kind: q.get('kind') === 'claude' ? 'claude' : 'shell', cwd, cols: +q.get('cols'), rows: +q.get('rows') });
    } catch (e) {
      ws.send(`\r\n\x1b[31mFailed to start terminal: ${e.message}\x1b[0m\r\n`);
      return ws.close();
    }
  } else if (s.buffer) {
    ws.send(s.buffer);
  }
  // Control frames are prefixed with NUL so the client can tell them from output.
  ws.send('\x00' + JSON.stringify({ t: 'session', id: s.id, kind: s.kind }));
  s.clients.add(ws);

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (s.exited) return;
    if (m.t === 'in' && typeof m.d === 'string') s.pty.write(m.d);
    else if (m.t === 'resize' && m.cols > 0 && m.rows > 0) {
      try { s.pty.resize(Math.min(500, m.cols | 0), Math.min(200, m.rows | 0)); } catch {}
    }
  });
  ws.on('close', () => s.clients.delete(ws));
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('\n  \x1b[1mPocket IDE\x1b[0m is running');
  console.log(`  Workspace : ${ROOT}`);
  console.log(`  Shell     : ${SHELL}`);
  console.log(`  Claude CLI: ${hasCommand('claude') ? 'found' : 'not found (npm i -g @anthropic-ai/claude-code)'}`);
  console.log(`\n  Open on your phone:\n  \x1b[36mhttp://${shown}:${PORT}/?token=${TOKEN}\x1b[0m\n`);
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  LAN: http://${a.address}:${PORT}/?token=${TOKEN}`);
    }
    console.log('');
  }
});
