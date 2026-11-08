#!/usr/bin/env node
// Phone bridge — runs in *native* Termux (not inside proot Ubuntu) so it can
// reach Android through Termux:API. Exposes a small token-protected HTTP API on
// 127.0.0.1 that the `phone` CLI (used by you and by Claude) talks to, and runs
// persistent automations: location triggers (geofences) and timed reminders.
//
// No npm dependencies on purpose: `pkg install nodejs termux-api` is enough.
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PHONE_BRIDGE_PORT || 8788);
const DIR = process.env.POCKET_IDE_HOME || path.join(os.homedir(), '.pocket-ide');
const TOKEN_FILE = path.join(DIR, 'token');
const DB_FILE = path.join(DIR, 'automations.json');
const CONFIG_FILE = path.join(DIR, 'bridge-config.json');
const LOG_FILE = path.join(DIR, 'bridge.log');
fs.mkdirSync(DIR, { recursive: true });

if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(16).toString('hex'), { mode: 0o600 });
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

// Commands that read private data or cost money / contact people are off by
// default. Turn them on in ~/.pocket-ide/bridge-config.json: {"allowSensitive": true}
const config = { allowSensitive: false, ...readJSON(CONFIG_FILE, {}) };

const SAFE = new Set([
  'location', 'notification', 'notification-remove', 'toast', 'tts-speak', 'vibrate', 'torch',
  'battery-status', 'clipboard-get', 'clipboard-set', 'open-url', 'open', 'share', 'sensor',
  'wifi-connectioninfo', 'volume', 'brightness', 'media-player', 'dialog', 'wallpaper',
  'audio-info', 'telephony-deviceinfo', 'job-scheduler', 'download', 'media-scan',
]);
const SENSITIVE = new Set([
  'sms-send', 'sms-list', 'contact-list', 'call-log', 'telephony-call', 'camera-photo',
  'microphone-record', 'notification-list', 'fingerprint', 'telephony-cellinfo',
]);

const MOCK = !hasBin('termux-notification');

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function hasBin(b) {
  return (process.env.PATH || '').split(':').some((p) => { try { fs.accessSync(path.join(p, b), fs.constants.X_OK); return true; } catch { return false; } });
}

// ---------- termux-api runner ----------
function termux(cmd, args = [], { timeout = 30000, input } = {}) {
  return new Promise((resolve) => {
    if (MOCK) {
      log('MOCK termux-' + cmd, JSON.stringify(args));
      if (cmd === 'location') return resolve({ ok: true, out: { latitude: 13.0827, longitude: 80.2707, accuracy: 50, provider: 'mock' } });
      if (cmd === 'battery-status') return resolve({ ok: true, out: { percentage: 80, status: 'DISCHARGING', plugged: 'UNPLUGGED' } });
      return resolve({ ok: true, out: '', mock: true });
    }
    const child = execFile('termux-' + cmd, args.map(String), { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = stdout.trim();
      try { out = out ? JSON.parse(out) : ''; } catch {}
      if (err) resolve({ ok: false, error: (stderr || err.message).trim(), out });
      else resolve({ ok: true, out });
    });
    if (input != null) { child.stdin.write(String(input)); }
    child.stdin.end();
  });
}

async function notify(title, content, { id, vibrate = true, sound = true } = {}) {
  const args = ['--title', title, '--content', content, '--priority', 'high'];
  if (id) args.push('--id', id);
  if (vibrate) args.push('--vibrate', '300,150,300');
  if (sound) args.push('--sound');
  return termux('notification', args);
}

function runHook(command, ctx) {
  if (!command) return;
  log('hook:', command);
  const child = spawn('sh', ['-c', command], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, POCKET_EVENT: ctx.event, POCKET_NAME: ctx.name || '', POCKET_ID: ctx.id },
  });
  child.unref();
}

// ---------- automations store ----------
let db = { geofences: [], reminders: [], ...readJSON(DB_FILE, {}) };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const newId = () => crypto.randomBytes(4).toString('hex');

// ---------- geofence engine ----------
// Android's native GeofencingClient isn't reachable from Termux:API, so we poll —
// but adaptively: far away = rare low-power network fixes; close = frequent GPS.
const R = 6371000;
function haversine(a, b, c, d) {
  const t = (x) => (x * Math.PI) / 180;
  const dLat = t(c - a), dLon = t(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

let lastFix = null;
let geoTimer = null;
let geoBusy = false;

async function getFix(precise) {
  const tries = precise ? ['gps', 'network'] : ['network', 'gps'];
  for (const p of tries) {
    const r = await termux('location', ['-p', p, '-r', 'once'], { timeout: precise ? 60000 : 30000 });
    if (r.ok && r.out && typeof r.out.latitude === 'number') return { ...r.out, at: Date.now() };
  }
  const r = await termux('location', ['-p', 'network', '-r', 'last']);
  return r.ok && r.out?.latitude != null ? { ...r.out, at: Date.now(), stale: true } : null;
}

async function geoTick() {
  if (geoBusy) return;
  geoBusy = true;
  clearTimeout(geoTimer);
  let next = 15 * 60_000;
  try {
    const active = db.geofences.filter((g) => g.enabled !== false);
    if (!active.length) return;
    // Use GPS only when we were already close to some fence last time.
    const nearBefore = lastFix && active.some((g) => Math.abs(haversine(lastFix.latitude, lastFix.longitude, g.lat, g.lon) - g.radius) < 1500);
    const fix = await getFix(nearBefore);
    if (!fix) { next = 2 * 60_000; return; }
    lastFix = fix;
    let minEdge = Infinity;
    for (const g of active) {
      const dist = haversine(fix.latitude, fix.longitude, g.lat, g.lon);
      const slack = Math.min(fix.accuracy || 0, g.radius); // don't fire on a wildly inaccurate fix
      const inside = dist <= g.radius + slack * 0.5;
      g.lastDistance = Math.round(dist);
      minEdge = Math.min(minEdge, Math.abs(dist - g.radius));
      if (g.inside === undefined) { g.inside = inside; continue; } // first reading just sets state
      const fired = (g.trigger === 'exit' && g.inside && !inside) || (g.trigger !== 'exit' && !g.inside && inside);
      g.inside = inside;
      if (fired) {
        log(`geofence ${g.id} (${g.name}) ${g.trigger || 'enter'} at ${Math.round(dist)}m`);
        g.lastFired = Date.now();
        await notify(g.title || `📍 ${g.name}`, g.message || `You ${g.trigger === 'exit' ? 'left' : 'arrived at'} ${g.name}`, { id: 'geo-' + g.id });
        runHook(g.command, { event: 'geofence-' + (g.trigger || 'enter'), name: g.name, id: g.id });
        if (!g.repeat) g.enabled = false;
      }
    }
    save();
    // Assume up to ~20 m/s (72 km/h) travel: check again before we could cross an edge.
    next = Math.max(30_000, Math.min(15 * 60_000, (minEdge / 20) * 1000));
  } catch (e) {
    log('geoTick error', e.message);
    next = 2 * 60_000;
  } finally {
    geoBusy = false;
    if (db.geofences.some((g) => g.enabled !== false)) geoTimer = setTimeout(geoTick, next);
  }
}

// ---------- reminder engine ----------
function nextRepeat(at, repeat) {
  const step = { hourly: 3600e3, daily: 86400e3, weekly: 7 * 86400e3 }[repeat] || Number(repeat) || 0;
  if (!step) return null;
  let t = at;
  while (t <= Date.now()) t += step;
  return t;
}
async function reminderTick() {
  let changed = false;
  for (const r of db.reminders) {
    if (r.enabled === false || r.at > Date.now()) continue;
    log(`reminder ${r.id} fired: ${r.message}`);
    await notify(r.title || '⏰ Reminder', r.message, { id: 'rem-' + r.id });
    if (r.speak) termux('tts-speak', [r.message]);
    runHook(r.command, { event: 'reminder', name: r.message, id: r.id });
    r.lastFired = Date.now();
    const n = r.repeat && nextRepeat(r.at, r.repeat);
    if (n) r.at = n; else r.enabled = false;
    changed = true;
  }
  if (changed) {
    db.reminders = db.reminders.filter((r) => r.enabled !== false || Date.now() - (r.lastFired || 0) < 86400e3);
    save();
  }
}
setInterval(reminderTick, 15_000);

// ---------- http api ----------
function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function authed(req) {
  const t = req.headers['x-bridge-token'] || '';
  return t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}
const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${name} must be a number`); return n; };

const routes = {
  'GET /status': async () => ({
    ok: true, mock: MOCK, allowSensitive: config.allowSensitive, pid: process.pid, uptime: Math.round(process.uptime()),
    geofences: db.geofences.filter((g) => g.enabled !== false).length,
    reminders: db.reminders.filter((r) => r.enabled !== false).length,
    lastFix,
  }),
  'POST /call': async (b) => {
    const cmd = String(b.cmd || '').replace(/^termux-/, '');
    if (!SAFE.has(cmd) && !SENSITIVE.has(cmd)) throw Object.assign(new Error(`Command not allowed: ${cmd}`), { status: 403 });
    if (SENSITIVE.has(cmd) && !config.allowSensitive) {
      throw Object.assign(new Error(`"${cmd}" is a sensitive command and is disabled. Enable with {"allowSensitive": true} in ${CONFIG_FILE} and restart the bridge.`), { status: 403 });
    }
    const args = Array.isArray(b.args) ? b.args.map(String) : [];
    return termux(cmd, args, { input: b.input, timeout: Math.min(Number(b.timeout) || 30000, 120000) });
  },
  // Android intents via Termux's `am`: open apps, set alarms, navigate, share…
  'POST /intent': async (b) => {
    const args = Array.isArray(b.args) ? b.args.map(String) : [];
    if (!args.length) throw new Error('args required, e.g. ["-a","android.intent.action.VIEW","-d","https://…"]');
    if (MOCK) { log('MOCK am start', JSON.stringify(args)); return { ok: true, mock: true }; }
    return new Promise((resolve) => {
      execFile('am', ['start', '--user', '0', ...args], { timeout: 20000 }, (err, stdout, stderr) => {
        const text = (stdout + stderr).trim();
        resolve(err || /Error|Exception/.test(text) ? { ok: false, error: text || err.message } : { ok: true, out: text });
      });
    });
  },
  'GET /automations': async () => ({ geofences: db.geofences, reminders: db.reminders }),
  'POST /geofences': async (b) => {
    const g = {
      id: newId(), name: String(b.name || 'Place'), lat: num(b.lat, 'lat'), lon: num(b.lon, 'lon'),
      radius: Math.max(50, Number(b.radius) || 300), trigger: b.trigger === 'exit' ? 'exit' : 'enter',
      title: b.title, message: b.message, command: b.command, repeat: !!b.repeat, enabled: true, created: Date.now(),
    };
    db.geofences.push(g); save();
    log(`geofence added ${g.id} ${g.name} ${g.lat},${g.lon} r=${g.radius} ${g.trigger}`);
    setTimeout(geoTick, 500);
    return g;
  },
  'POST /reminders': async (b) => {
    const at = typeof b.at === 'number' ? b.at : Date.parse(b.at);
    if (!Number.isFinite(at)) throw new Error('at must be a timestamp or ISO date');
    const r = { id: newId(), at, message: String(b.message || 'Reminder'), title: b.title, repeat: b.repeat || null,
      speak: !!b.speak, command: b.command, enabled: true, created: Date.now() };
    db.reminders.push(r); save();
    log(`reminder added ${r.id} at ${new Date(at).toISOString()}`);
    return r;
  },
};

const server = http.createServer(async (req, res) => {
  if (!authed(req)) return send(res, 401, { error: 'bad or missing x-bridge-token' });
  const url = new URL(req.url, 'http://x');
  try {
    const del = url.pathname.match(/^\/(geofences|reminders)\/([a-f0-9]+)$/);
    if (req.method === 'DELETE' && del) {
      const list = db[del[1]];
      const i = list.findIndex((x) => x.id === del[2]);
      if (i < 0) return send(res, 404, { error: 'not found' });
      list.splice(i, 1); save();
      return send(res, 200, { ok: true });
    }
    const h = routes[`${req.method} ${url.pathname}`];
    if (!h) return send(res, 404, { error: 'no such route' });
    const body = req.method === 'POST' ? await readBody(req) : {};
    send(res, 200, await h(body));
  } catch (e) {
    send(res, e.status || 400, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`phone bridge listening on 127.0.0.1:${PORT}${MOCK ? ' (MOCK mode: termux-api not found)' : ''}`);
  if (db.geofences.some((g) => g.enabled !== false)) geoTick();
  reminderTick();
});
