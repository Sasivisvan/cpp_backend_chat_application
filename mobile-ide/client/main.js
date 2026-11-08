// Pocket IDE client — file explorer, CodeMirror editor, xterm terminals,
// Claude Code panel and live preview, tuned for touch screens.
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { java } from '@codemirror/lang-java';
import { rust } from '@codemirror/lang-rust';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------- settings / storage ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('pide.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pide.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('pide.' + k); } catch {} },
};
const settings = {
  fontSize: store.get('fontSize', 14),
  wrap: store.get('wrap', true),
  hidden: store.get('hidden', false),
};

// ---------- auth ----------
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) {
  store.set('token', urlToken);
  history.replaceState(null, '', location.pathname);
}
let TOKEN = store.get('token', '');

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ''), err ? 3500 : 1800);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: { 'x-ide-token': TOKEN, ...(opts.headers || {}) },
  });
  if (res.status === 401) { showLogin(); throw new Error('Unauthorized'); }
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || res.statusText);
  return body;
}
const q = (p) => encodeURIComponent(p);

function showLogin() {
  // Inside the Android app: it can fetch the token from Termux by itself.
  if (window.PocketIDE?.fetchToken && !showLogin.tried) { showLogin.tried = true; window.PocketIDE.fetchToken(); }
  $('#login').classList.remove('hidden');
  $('#tokenInput').focus();
}
$('#tokenSave').onclick = () => {
  let v = $('#tokenInput').value.trim();
  const m = v.match(/token=([a-f0-9]+)/i);
  if (m) v = m[1];
  if (!v) return;
  TOKEN = v;
  store.set('token', v);
  location.reload();
};

// ---------- panels ----------
let currentPanel = 'files';
function showPanel(name) {
  currentPanel = name;
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
  $$('#bottomnav button').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  $('#keybar').classList.toggle('hidden', !(name === 'term' || name === 'claude'));
  $('#saveBtn').classList.toggle('hidden', name !== 'code');
  store.set('panel', name);
  if (name === 'term' || name === 'claude') termPanels[name].onShow();
  if (name === 'code') editorView?.requestMeasure();
  if (name === 'phone') loadPhone();
  updateSubtitle();
}
$$('#bottomnav button').forEach((b) => (b.onclick = () => showPanel(b.dataset.panel)));
$('#menuBtn').onclick = () => showPanel('files');

// Hide bottom nav while the soft keyboard is open to save space.
if (window.visualViewport) {
  const base = window.innerHeight;
  visualViewport.addEventListener('resize', () => {
    document.body.classList.toggle('kb-open', visualViewport.height < base * 0.75);
    document.body.style.height = visualViewport.height + 'px';
    fitActiveTerm();
  });
}

// ---------- file explorer ----------
let cwd = store.get('cwd', '');
let info = null;

const ICONS = { js: '🟨', mjs: '🟨', ts: '🔷', tsx: '🔷', jsx: '🟨', py: '🐍', cpp: '⚙️', cc: '⚙️', c: '⚙️', h: '⚙️', hpp: '⚙️',
  html: '🌐', css: '🎨', json: '🧾', md: '📘', java: '☕', rs: '🦀', go: '🐹', sh: '🐚', png: '🖼', jpg: '🖼', svg: '🖼', txt: '📄' };
const ext = (p) => (p.split('/').pop().includes('.') ? p.split('.').pop().toLowerCase() : '');

async function loadDir(path = cwd) {
  try {
    const data = await api(`/tree?path=${q(path)}${settings.hidden ? '&hidden=1' : ''}`);
    cwd = data.path;
    store.set('cwd', cwd);
    $('#cwdLabel').textContent = '/' + cwd;
    const ul = $('#fileList');
    ul.innerHTML = '';
    if (!data.entries.length) ul.innerHTML = '<li><span class="name" style="color:var(--muted)">Empty folder</span></li>';
    for (const e of data.entries) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="ico">${e.type === 'dir' ? '📁' : ICONS[ext(e.name)] || '📄'}</span><span class="name"></span><button class="act" aria-label="Actions">⋯</button>`;
      $('.name', li).textContent = e.name;
      li.onclick = (ev) => {
        if (ev.target.classList.contains('act')) return fileActions(e);
        e.type === 'dir' ? loadDir(e.path) : openFile(e.path);
      };
      let pressTimer;
      li.addEventListener('touchstart', () => (pressTimer = setTimeout(() => fileActions(e), 550)), { passive: true });
      li.addEventListener('touchend', () => clearTimeout(pressTimer));
      li.addEventListener('touchmove', () => clearTimeout(pressTimer));
      ul.appendChild(li);
    }
  } catch (err) {
    if (path) { cwd = ''; return loadDir(''); }
    toast(err.message, true);
  }
}

async function fileActions(e) {
  const choice = prompt(`${e.name}\n\nType an action:\n  r = rename / move\n  d = delete\n  t = open terminal here\n  c = ask Claude about it`, 'r');
  if (!choice) return;
  const c = choice.trim().toLowerCase()[0];
  try {
    if (c === 'r') {
      const to = prompt('New path (relative to workspace):', e.path);
      if (to && to !== e.path) {
        await api('/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: e.path, to }) });
        renameOpenFile(e.path, to);
        loadDir();
      }
    } else if (c === 'd') {
      if (confirm(`Delete ${e.path}${e.type === 'dir' ? ' and everything inside it' : ''}?`)) {
        await api(`/file?path=${q(e.path)}`, { method: 'DELETE' });
        closeFile(e.path, true);
        loadDir();
      }
    } else if (c === 't') {
      showPanel('term');
      termPanels.term.newSession(e.type === 'dir' ? e.path : e.path.split('/').slice(0, -1).join('/'));
    } else if (c === 'c') {
      showPanel('claude');
      termPanels.claude.send(`@${e.path} `);
    }
  } catch (err) { toast(err.message, true); }
}

async function newEntry(kind) {
  const name = prompt(kind === 'dir' ? 'New folder name:' : 'New file name (e.g. src/app.js):');
  if (!name) return;
  const path = (cwd ? cwd + '/' : '') + name.replace(/^\/+/, '');
  try {
    if (kind === 'dir') await api('/mkdir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    else {
      await api(`/file?path=${q(path)}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: '' });
      openFile(path);
    }
    loadDir();
  } catch (err) { toast(err.message, true); }
}

$('#upBtn').onclick = () => loadDir(cwd.split('/').slice(0, -1).join('/'));
$('#refreshBtn').onclick = () => loadDir();
$('#newFileBtn').onclick = () => newEntry('file');
$('#newDirBtn').onclick = () => newEntry('dir');

// ---------- editor ----------
const LANGS = {
  js: () => javascript(), mjs: () => javascript(), cjs: () => javascript(), jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }), tsx: () => javascript({ typescript: true, jsx: true }),
  py: python, c: cpp, h: cpp, cc: cpp, cpp: cpp, hpp: cpp, cxx: cpp, ino: cpp,
  html: html, htm: html, vue: html, svelte: html, css: css, scss: css,
  json: json, md: markdown, markdown: markdown, java: java, kt: java, rs: rust,
};
const langComp = new Compartment();
const wrapComp = new Compartment();
const fontComp = new Compartment();
const fontTheme = () => EditorView.theme({ '&': { fontSize: settings.fontSize + 'px' } });

let editorView = null;
const files = []; // { path, state, dirty, saved }
let activeFile = null;

function extensionsFor(path) {
  const lang = LANGS[ext(path)];
  return [
    basicSetup,
    oneDark,
    keymap.of([
      indentWithTab,
      { key: 'Mod-s', preventDefault: true, run: () => (saveFile(), true) },
    ]),
    langComp.of(lang ? lang() : []),
    wrapComp.of(settings.wrap ? EditorView.lineWrapping : []),
    fontComp.of(fontTheme()),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && activeFile) {
        const f = files.find((x) => x.path === activeFile);
        if (f && !f.dirty) { f.dirty = true; renderTabs(); }
      }
    }),
  ];
}

async function openFile(path) {
  let f = files.find((x) => x.path === path);
  if (!f) {
    try {
      const text = await api(`/file?path=${q(path)}`);
      f = { path, state: EditorState.create({ doc: text, extensions: extensionsFor(path) }), dirty: false };
      files.push(f);
    } catch (err) { return toast(err.message, true); }
  }
  activate(path);
  showPanel('code');
}

function activate(path) {
  if (activeFile && editorView) {
    const prev = files.find((x) => x.path === activeFile);
    if (prev) prev.state = editorView.state;
  }
  activeFile = path;
  const f = files.find((x) => x.path === path);
  $('#editorEmpty').classList.toggle('hidden', !!f);
  $('#editorHost').classList.toggle('hidden', !f);
  if (f) {
    if (!editorView) editorView = new EditorView({ state: f.state, parent: $('#editorHost') });
    else editorView.setState(f.state);
    // Re-apply live settings in case they changed while this tab was inactive.
    editorView.dispatch({ effects: [wrapComp.reconfigure(settings.wrap ? EditorView.lineWrapping : []), fontComp.reconfigure(fontTheme())] });
  }
  store.set('openFiles', files.map((x) => x.path));
  store.set('activeFile', activeFile);
  renderTabs();
  updateSubtitle();
}

function renderTabs() {
  const el = $('#editorTabs');
  el.innerHTML = '';
  for (const f of files) {
    const t = document.createElement('div');
    t.className = 'tab' + (f.path === activeFile ? ' active' : '') + (f.dirty ? ' dirty' : '');
    t.innerHTML = '<span class="label"></span><button class="x" aria-label="Close">✕</button>';
    $('.label', t).textContent = f.path.split('/').pop();
    t.title = f.path;
    t.onclick = (e) => (e.target.classList.contains('x') ? closeFile(f.path) : activate(f.path));
    el.appendChild(t);
  }
  $('#saveBtn').classList.toggle('dirty', !!files.find((x) => x.path === activeFile)?.dirty);
  if (el.querySelector('.active')) el.querySelector('.active').scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function closeFile(path, force = false) {
  const i = files.findIndex((x) => x.path === path || x.path.startsWith(path + '/'));
  if (i < 0) return;
  if (!force && files[i].dirty && !confirm(`Discard unsaved changes to ${path}?`)) return;
  files.splice(i, 1);
  if (force) return closeFile(path, true) ?? finishClose(path);
  finishClose(path);
}
function finishClose(path) {
  if (activeFile === path || (activeFile && activeFile.startsWith(path + '/')) || !files.find((x) => x.path === activeFile)) {
    activeFile = null;
    const next = files[files.length - 1];
    if (next) activate(next.path);
    else activate(null);
  } else renderTabs();
}
function renameOpenFile(from, to) {
  for (const f of files) {
    if (f.path === from) f.path = to;
    else if (f.path.startsWith(from + '/')) f.path = to + f.path.slice(from.length);
  }
  if (activeFile === from) activeFile = to;
  renderTabs();
}

async function saveFile() {
  const f = files.find((x) => x.path === activeFile);
  if (!f || !editorView) return;
  try {
    await api(`/file?path=${q(f.path)}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: editorView.state.doc.toString() });
    f.dirty = false;
    renderTabs();
    toast('Saved ' + f.path.split('/').pop());
  } catch (err) { toast(err.message, true); }
}
$('#saveBtn').onclick = saveFile;

// Reload an open, unmodified file when you come back to the editor (Claude may have changed it).
async function refreshOpenFiles() {
  for (const f of files) {
    if (f.dirty) continue;
    try {
      const text = await api(`/file?path=${q(f.path)}`);
      const state = f.path === activeFile && editorView ? editorView.state : f.state;
      if (state.doc.toString() === text) continue;
      if (f.path === activeFile && editorView) {
        editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: text } });
        f.dirty = false;
      } else {
        f.state = EditorState.create({ doc: text, extensions: extensionsFor(f.path) });
      }
    } catch {}
  }
  renderTabs();
}

// ---------- terminals (shell + Claude) ----------
// ---------- touch scrolling ----------
// xterm.js barely scrolls with a finger on phones. Swipe = scroll with momentum:
//  - normal output (shell, Claude Code): scroll the scrollback
//  - full-screen apps that capture the mouse: send mouse-wheel events to the app
//  - full-screen apps without mouse: send PageUp / PageDown
function scrollTerm(s, lines) {
  const t = s.term;
  if (!lines) return;
  if (t.modes.mouseTrackingMode && t.modes.mouseTrackingMode !== 'none') {
    const btn = lines < 0 ? 64 : 65;
    const col = Math.max(1, Math.floor(t.cols / 2)), row = Math.max(1, Math.floor(t.rows / 2));
    const n = Math.min(Math.abs(lines), 15);
    let seq = '';
    for (let i = 0; i < n; i++) seq += `\x1b[<${btn};${col};${row}M`;
    s.write(seq);
  } else if (t.buffer.active.type === 'alternate') {
    const pages = Math.max(1, Math.round(Math.abs(lines) / Math.max(1, t.rows - 2)));
    s.write((lines < 0 ? '\x1b[5~' : '\x1b[6~').repeat(pages));
  } else {
    t.scrollLines(lines);
  }
}
function scrollPage(s, dir) {
  const t = s.term;
  if (dir === 0) { t.scrollToBottom(); return; }
  scrollTerm(s, dir * Math.max(1, t.rows - 2));
}
function attachTouchScroll(s) {
  const el = s.el;
  const lineH = () => {
    const r = el.querySelector('.xterm-rows');
    return (r && r.firstElementChild && r.firstElementChild.getBoundingClientRect().height) || s.term.options.fontSize * 1.25;
  };
  let lastY = null, startY = 0, acc = 0, vel = 0, lastT = 0, moved = false, raf = 0;
  const altStep = () => (s.term.buffer.active.type === 'alternate' && (!s.term.modes.mouseTrackingMode || s.term.modes.mouseTrackingMode === 'none')) ? Math.max(1, s.term.rows - 2) : 1;
  const apply = (dy) => {
    acc += dy / lineH();
    const step = altStep();
    const whole = acc > 0 ? Math.floor(acc / step) * step : Math.ceil(acc / step) * step;
    if (whole) { acc -= whole; scrollTerm(s, whole); }
  };
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    cancelAnimationFrame(raf);
    lastY = startY = e.touches[0].clientY; lastT = performance.now(); vel = 0; acc = 0; moved = false;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (lastY === null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    if (!moved && Math.abs(y - startY) < 8) return; // let taps through
    moved = true;
    e.preventDefault();
    e.stopPropagation();
    const now = performance.now();
    const dy = lastY - y; // finger up = scroll down (towards newer output)
    vel = 0.8 * (dy / Math.max(1, now - lastT)) + 0.2 * vel;
    lastY = y; lastT = now;
    apply(dy);
  }, { passive: false, capture: true });
  el.addEventListener('touchend', () => {
    lastY = null;
    if (!moved || Math.abs(vel) < 0.3 || altStep() > 1) return;
    let v = vel * 16; // px per frame
    const tick = () => { apply(v); v *= 0.94; if (Math.abs(v) > 0.5) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
  }, { passive: true });
}

const KEYMAP = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', 'ctrl-c': '\x03' };
const mods = { ctrl: false, alt: false };

function applyMods(d) {
  if (!mods.ctrl && !mods.alt) return d;
  if (d.length === 1) {
    if (mods.ctrl) {
      const c = d.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
      else if (d === ' ') d = '\x00';
    }
    if (mods.alt) d = '\x1b' + d;
  }
  mods.ctrl = mods.alt = false;
  $$('#keybar [data-mod]').forEach((b) => b.classList.remove('on'));
  return d;
}

class TermSession {
  constructor(panel, { id = null, cwd: dir = '' } = {}) {
    this.panel = panel;
    this.id = id;
    this.cwd = dir;
    this.el = document.createElement('div');
    this.el.className = 'term';
    panel.host.appendChild(this.el);
    this.term = new Terminal({
      fontSize: settings.fontSize - 1,
      fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: { background: '#0f1115', foreground: '#e3e6ec', cursor: '#d97757', selectionBackground: '#3e4451' },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((e, uri) => {
      if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(uri)) { $('#previewUrl').value = uri; loadPreview(); showPanel('preview'); }
      else window.open(uri, '_blank');
    }));
    this.term.open(this.el);
    attachTouchScroll(this);
    this.term.onData((d) => this.write(applyMods(d)));
    this.term.onResize(({ cols, rows }) => this.sendJSON({ t: 'resize', cols, rows }));
    this.title = panel.kind === 'claude' ? 'Claude' : 'bash';
    this.term.onTitleChange((t) => { this.title = t.slice(0, 24) || this.title; panel.renderTabs(); });
    this.retries = 0;
    this.closed = false;
    this.connect();
  }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams({ token: TOKEN, kind: this.panel.kind, cwd: this.cwd, cols: this.term.cols, rows: this.term.rows });
    if (this.id) params.set('id', this.id);
    const ws = (this.ws = new WebSocket(`${proto}://${location.host}/pty?${params}`));
    let replayed = false;
    ws.onmessage = (ev) => {
      const d = ev.data;
      if (typeof d === 'string' && d[0] === '\x00') {
        const m = JSON.parse(d.slice(1));
        if (m.t === 'session') { this.id = m.id; this.retries = 0; this.panel.persist(); }
        return;
      }
      // On reconnect the server replays scrollback — clear first to avoid duplicates.
      if (!replayed && this.reconnecting) { this.term.reset(); }
      replayed = true;
      this.term.write(d);
    };
    ws.onopen = () => { this.fitNow(); };
    ws.onclose = (ev) => {
      if (this.closed) return;
      if (ev.code === 4000) { this.id = null; this.panel.persist(); this.exited = true; this.term.write('\r\n\x1b[90mPress Enter to start a new session.\x1b[0m'); return; }
      if (this.retries++ < 30) {
        this.reconnecting = true;
        setTimeout(() => this.connect(), Math.min(5000, 300 * this.retries));
      }
    };
  }
  write(d) {
    if (this.exited) {
      if (d === '\r') { this.exited = false; this.reconnecting = false; this.term.reset(); this.connect(); }
      return;
    }
    this.sendJSON({ t: 'in', d });
  }
  sendJSON(o) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o)); }
  fitNow() { if (this.el.offsetParent) { try { this.fit.fit(); } catch {} this.sendJSON({ t: 'resize', cols: this.term.cols, rows: this.term.rows }); } }
  setFont(px) { this.term.options.fontSize = px; this.fitNow(); }
  dispose(kill = true) {
    this.closed = true;
    if (kill && this.id) api(`/sessions/${this.id}`, { method: 'DELETE' }).catch(() => {});
    this.ws?.close();
    this.term.dispose();
    this.el.remove();
  }
}

class TermPanel {
  constructor(el) {
    this.el = el;
    this.kind = el.dataset.kind;
    this.host = $('.term-host', el);
    this.tabsEl = $('.term-tabs', el);
    this.sessions = [];
    this.active = null;
    this.started = false;
  }
  onShow() {
    if (!this.started) {
      this.started = true;
      const saved = store.get('sessions.' + this.kind, []);
      if (saved.length) saved.forEach((id) => this.add(new TermSession(this, { id })));
      else this.newSession(cwd);
    }
    requestAnimationFrame(() => { this.active?.fitNow(); if (!matchMedia('(pointer: coarse)').matches) this.active?.term.focus(); });
  }
  newSession(dir = '') { this.add(new TermSession(this, { cwd: dir })); }
  add(s) { this.sessions.push(s); this.select(s); }
  select(s) {
    this.active = s;
    this.sessions.forEach((x) => x.el.classList.toggle('active', x === s));
    this.renderTabs();
    requestAnimationFrame(() => s.fitNow());
  }
  close(s) {
    s.dispose();
    this.sessions = this.sessions.filter((x) => x !== s);
    this.persist();
    if (this.active === s) {
      const n = this.sessions[this.sessions.length - 1];
      if (n) this.select(n); else { this.active = null; this.newSession(cwd); }
    } else this.renderTabs();
  }
  persist() { store.set('sessions.' + this.kind, this.sessions.map((s) => s.id).filter(Boolean)); }
  renderTabs() {
    this.tabsEl.innerHTML = '';
    this.sessions.forEach((s, i) => {
      const t = document.createElement('div');
      t.className = 'tab' + (s === this.active ? ' active' : '');
      t.innerHTML = '<span class="label"></span><button class="x" aria-label="Close">✕</button>';
      $('.label', t).textContent = `${i + 1}: ${s.title}`;
      t.onclick = (e) => (e.target.classList.contains('x') ? this.close(s) : this.select(s));
      this.tabsEl.appendChild(t);
    });
    const add = document.createElement('button');
    add.className = 'tab add';
    add.textContent = '＋';
    add.onclick = () => this.newSession(cwd);
    this.tabsEl.appendChild(add);
  }
  send(text) { if (this.active) this.active.write(text); }
}

const termPanels = { term: new TermPanel($('#panel-term')), claude: new TermPanel($('#panel-claude')) };
function fitActiveTerm() { termPanels[currentPanel]?.active?.fitNow(); }
window.addEventListener('resize', fitActiveTerm);

// Extra-keys bar for touch keyboards
$$('#keybar button').forEach((b) => {
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in terminal
  b.onclick = async () => {
    const panel = termPanels[currentPanel];
    if (!panel?.active) return;
    if (b.dataset.mod) {
      mods[b.dataset.mod] = !mods[b.dataset.mod];
      b.classList.toggle('on', mods[b.dataset.mod]);
      panel.active.term.focus();
      return;
    }
    const k = b.dataset.key;
    if (k === 'pgup' || k === 'pgdn' || k === 'end') {
      scrollPage(panel.active, k === 'pgup' ? -1 : k === 'pgdn' ? 1 : 0);
      return;
    }
    if (k === 'paste') {
      try { panel.send(window.PocketIDE ? window.PocketIDE.readClipboard() : await navigator.clipboard.readText()); }
      catch { const t = prompt('Paste text:'); if (t) panel.send(t); }
      return;
    }
    let seq = KEYMAP[k] ?? k;
    if (mods.alt && seq.startsWith('\x1b[')) seq = seq.replace('\x1b[', '\x1b[1;3');
    else seq = applyMods(seq);
    mods.ctrl = mods.alt = false;
    $$('#keybar [data-mod]').forEach((x) => x.classList.remove('on'));
    panel.send(seq);
  };
});

// Claude prompt box: a comfortable way to type long messages on a phone.
const promptInput = $('#promptInput');
promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(120, promptInput.scrollHeight) + 'px';
});
$('#promptForm').onsubmit = (e) => {
  e.preventDefault();
  const text = promptInput.value;
  if (!text.trim()) { termPanels.claude.send('\r'); return; }
  // Bracketed paste keeps multi-line prompts as one message in Claude Code.
  termPanels.claude.send(text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
  setTimeout(() => termPanels.claude.send('\r'), 60);
  promptInput.value = '';
  promptInput.style.height = 'auto';
};
$$('#panel-claude .quick .chip').forEach((c) => {
  c.onclick = () => {
    if (c.dataset.file) {
      if (!activeFile) return toast('No file open', true);
      promptInput.value += `@${activeFile} `;
      promptInput.focus();
      return;
    }
    termPanels.claude.send(c.dataset.send);
    setTimeout(() => termPanels.claude.send('\r'), 60);
  };
});

// ---------- phone automations ----------
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function ago(t) {
  const s = Math.round((t - Date.now()) / 1000);
  const a = Math.abs(s);
  const v = a < 60 ? a + 's' : a < 3600 ? Math.round(a / 60) + 'm' : a < 86400 ? Math.round(a / 3600) + 'h' : Math.round(a / 86400) + 'd';
  return s >= 0 ? 'in ' + v : v + ' ago';
}
const km = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + 'km' : m + 'm');

async function loadPhone() {
  const st = $('#bridgeStatus');
  try {
    const s = await api('/phone/status');
    st.textContent = `● Bridge connected${s.mock ? ' (mock mode – no Termux:API)' : ''} · ${s.geofences} triggers · ${s.reminders} reminders`;
    st.style.color = 'var(--ok)';
    const NAMES = { 'contact-list': 'Contacts', 'sms-send': 'Send SMS', 'sms-list': 'Read SMS', 'call-log': 'Call log',
      'telephony-call': 'Make calls', 'camera-photo': 'Camera', 'microphone-record': 'Microphone', 'notification-list': 'Read notifications' };
    const allowed = (s.allowed || []).map((c) => NAMES[c] || c);
    const acc = $('#accessSummary');
    acc.innerHTML = `<li><div class="main"><div class="t">${allowed.length ? esc(allowed.join(', ')) : 'Basic only'}</div>` +
      `<div class="s">${allowed.length ? 'Claude may use these' : 'Contacts, SMS, calls, camera… are off'}</div></div>` +
      (window.PocketIDE?.openSetupAt ? '<button class="chip" id="manageAccess">Manage</button>' : '') + '</li>';
    $('#manageAccess')?.addEventListener('click', () => window.PocketIDE.openSetupAt('#access'));
    const a = await api('/phone/automations');
    renderCards('#geoList', a.geofences, (g) => ({
      t: `📍 ${g.name}`,
      s: [g.trigger === 'exit' ? 'On leaving' : 'On arriving', g.radius + 'm', g.repeat && 'repeats',
        g.lastDistance != null && `now ${km(g.lastDistance)} away`, g.enabled === false && 'done',
        g.message && `“${g.message}”`].filter(Boolean).join(' · '),
      off: g.enabled === false, del: `/phone/geofences/${g.id}`,
    }), 'No location triggers yet');
    renderCards('#remList', [...a.reminders].sort((x, y) => x.at - y.at), (r) => ({
      t: `⏰ ${r.message}`,
      s: [`${new Date(r.at).toLocaleString()} (${ago(r.at)})`, r.repeat, r.enabled === false && 'done'].filter(Boolean).join(' · '),
      off: r.enabled === false, del: `/phone/reminders/${r.id}`,
    }), 'No reminders yet');
  } catch (err) {
    st.textContent = '○ ' + err.message;
    st.style.color = 'var(--danger)';
    $('#geoList').innerHTML = '';
    $('#remList').innerHTML = '';
  }
}

function renderCards(sel, items, fmt, emptyText) {
  const ul = $(sel);
  ul.innerHTML = items.length ? '' : `<li class="none">${emptyText}</li>`;
  for (const it of items) {
    const f = fmt(it);
    const li = document.createElement('li');
    if (f.off) li.className = 'off';
    li.innerHTML = `<div class="main"><div class="t">${esc(f.t)}</div><div class="s">${esc(f.s)}</div></div><button class="del" aria-label="Delete">🗑</button>`;
    $('.del', li).onclick = async () => {
      if (!confirm('Delete this automation?')) return;
      try { await api(f.del, { method: 'DELETE' }); loadPhone(); } catch (e) { toast(e.message, true); }
    };
    ul.appendChild(li);
  }
}

async function phoneCall(cmd, args = []) {
  const r = await api('/phone/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, args, timeout: 60000 }) });
  if (!r.ok) throw new Error(r.error);
  return r.out;
}

$('#phoneRefresh').onclick = loadPhone;
$$('[data-phone]').forEach((b) => (b.onclick = async () => {
  const a = b.dataset.phone;
  const outEl = $('#phoneOut');
  if (a === 'ask') {
    const what = prompt('What should your phone do?\n(e.g. "remind me to call mom when I leave the office")');
    if (!what) return;
    showPanel('claude');
    termPanels.claude.send(what);
    setTimeout(() => termPanels.claude.send('\r'), 80);
    return;
  }
  outEl.classList.remove('hidden');
  outEl.textContent = '…';
  try {
    let r;
    if (a === 'location') r = await phoneCall('location', ['-p', 'network', '-r', 'once']);
    else if (a === 'battery') r = await phoneCall('battery-status');
    else if (a === 'notify') r = await phoneCall('notification', ['--title', 'Pocket IDE', '--content', 'Notifications work 🎉']);
    else if (a === 'vibrate') r = await phoneCall('vibrate', ['-d', '400', '-f']);
    outEl.textContent = typeof r === 'string' ? r || 'OK' : JSON.stringify(r, null, 2);
  } catch (e) { outEl.textContent = e.message; }
}));

// ---------- preview ----------
function loadPreview() {
  let u = $('#previewUrl').value.trim();
  if (!/^https?:\/\//.test(u)) u = 'http://' + u;
  $('#previewUrl').value = u;
  store.set('previewUrl', u);
  $('#previewFrame').src = u;
}
$('#previewUrl').value = store.get('previewUrl', 'http://localhost:3000');
$('#previewGo').onclick = loadPreview;
$('#previewUrl').addEventListener('keydown', (e) => e.key === 'Enter' && loadPreview());
$('#previewOpen').onclick = () => window.open($('#previewUrl').value, '_blank');

// ---------- menu ----------
$('#moreBtn').onclick = (e) => { e.stopPropagation(); $('#moreMenu').classList.toggle('hidden'); };
document.addEventListener('click', (e) => { if (!e.target.closest('#moreMenu')) $('#moreMenu').classList.add('hidden'); });
$$('#moreMenu button').forEach((b) => (b.onclick = () => {
  $('#moreMenu').classList.add('hidden');
  const a = b.dataset.act;
  if (a === 'newFile') newEntry('file');
  else if (a === 'newFolder') newEntry('dir');
  else if (a === 'search') { if (editorView) { showPanel('code'); openSearchPanel(editorView); } }
  else if (a === 'wrap') {
    settings.wrap = !settings.wrap; store.set('wrap', settings.wrap);
    editorView?.dispatch({ effects: wrapComp.reconfigure(settings.wrap ? EditorView.lineWrapping : []) });
    toast('Word wrap ' + (settings.wrap ? 'on' : 'off'));
  } else if (a === 'font+' || a === 'font-') {
    settings.fontSize = Math.max(9, Math.min(28, settings.fontSize + (a === 'font+' ? 1 : -1)));
    store.set('fontSize', settings.fontSize);
    editorView?.dispatch({ effects: fontComp.reconfigure(fontTheme()) });
    Object.values(termPanels).forEach((p) => p.sessions.forEach((s) => s.setFont(settings.fontSize - 1)));
    toast('Font ' + settings.fontSize + 'px');
  } else if (a === 'hidden') {
    settings.hidden = !settings.hidden; store.set('hidden', settings.hidden);
    loadDir();
  } else if (a === 'logout') { store.del('token'); location.reload(); }
  else if (a === 'apphome') { window.PocketIDE?.openSetup(); }
  else if (a === 'update') { window.PocketIDE?.promptUpdate(); }
}));

function updateSubtitle() {
  const s = currentPanel === 'code' && activeFile ? activeFile
    : currentPanel === 'files' ? '/' + cwd
    : currentPanel === 'claude' ? (info?.claude ? 'Claude Code' : 'Claude Code not installed')
    : currentPanel === 'term' ? info?.shell || ''
    : currentPanel === 'phone' ? 'Phone automations'
    : 'Preview';
  $('#subtitle').textContent = s;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { refreshOpenFiles(); if (currentPanel === 'files') loadDir(); }
});
window.addEventListener('beforeunload', (e) => { if (files.some((f) => f.dirty)) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(); }
});

// ---------- boot ----------
(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (window.PocketIDE) $$('.app-only').forEach((el) => el.classList.remove('hidden'));
  if (!TOKEN) return showLogin();
  try { info = await api('/info'); } catch (err) { if (err.message !== 'Unauthorized') toast(err.message, true); return; }
  $('#projectName').textContent = info.name;
  document.title = info.name + ' · Pocket IDE';
  if (matchMedia('(min-width: 900px)').matches) document.body.classList.add('split');
  await loadDir(cwd);
  activate(null);
  for (const p of store.get('openFiles', [])) {
    try {
      const text = await api(`/file?path=${q(p)}`);
      files.push({ path: p, state: EditorState.create({ doc: text, extensions: extensionsFor(p) }), dirty: false });
    } catch {}
  }
  const last = store.get('activeFile', null);
  if (files.length) activate(files.find((f) => f.path === last) ? last : files[0].path);
  showPanel(store.get('panel', 'files'));
})();
