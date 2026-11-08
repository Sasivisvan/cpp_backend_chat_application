#!/usr/bin/env node
// `phone` — control the Android phone from any terminal (and from Claude Code).
// Talks to phone-bridge.js running in native Termux. Prints JSON.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.PHONE_BRIDGE_URL || 'http://127.0.0.1:8788';
const TOKEN_FILE = process.env.PHONE_BRIDGE_TOKEN_FILE || path.join(os.homedir(), '.pocket-ide', 'token');

const HELP = `phone — control this Android phone (via Termux:API)

Info
  phone status                         bridge status, active automations, last location
  phone location [--gps]               current location (network by default, --gps = precise)
  phone battery                        battery level / charging state
  phone geocode "<place>"              place name -> lat/lon (OpenStreetMap)

Actions
  phone notify "<title>" "<text>"      show a notification
  phone toast "<text>"                 short on-screen message
  phone say "<text>"                   speak text aloud
  phone vibrate [ms]                   vibrate (default 500ms)
  phone torch on|off                   flashlight
  phone clip get | phone clip set "<text>"
  phone open <url|geo:lat,lon|tel:..>  open URL / map / dialer in the right app
  phone volume [stream level]          list volumes, or set e.g. "music 8"
  phone raw <termux-cmd> [args...]     any allowed termux-api command, e.g. raw sensor -s light -n 1

Apps & intents
  phone app <package>                  launch an app (com.whatsapp, com.spotify.music, …)
  phone alarm HH:MM "<label>" [--days 2,3,4,5,6]   real alarm in the Clock app (1=Sun)
  phone navigate "<place>"             start turn-by-turn navigation in Maps
  phone whatsapp "<name|+number>" "<msg>"   open WhatsApp chat with message pre-filled (user taps Send)
  phone sms "<name|+number>" "<msg>"        same, in the SMS app
                                       (names need contact access: allowSensitive in bridge-config.json)
  phone intent <am start args…>        any Android intent, e.g.
                                       phone intent -a android.intent.action.VIEW -d "https://wa.me/91XXXXXXXXXX?text=hi"

Automations (persist in the background, survive closing the app)
  phone geofence add (--place "<name>" | --lat N --lon N) [--name X] [--radius 300]
                     [--exit] [--repeat] [--message "..."] [--command "shell cmd"]
  phone geofence list
  phone geofence rm <id>
  phone remind (--in 10m|2h|1d | --at "18:30" | --at 2026-11-09T09:00) "<message>"
               [--repeat daily|hourly|weekly] [--speak] [--command "shell cmd"]
  phone remind list
  phone remind rm <id>
`;

function token() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); }
  catch { die(`No bridge token at ${TOKEN_FILE}. Is the phone bridge set up? (see Pocket IDE README)`); }
}
function die(msg, code = 1) { console.error('phone: ' + msg); process.exit(code); }
function out(v) { console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2)); }

async function call(method, route, body) {
  let res;
  try {
    res = await fetch(BASE + route, {
      method,
      headers: { 'x-bridge-token': token(), 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    die(`cannot reach the phone bridge at ${BASE}. Start it in Termux with: pocket-bridge`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(data.error || res.statusText);
  return data;
}
const termux = async (cmd, args = [], extra = {}) => {
  const r = await call('POST', '/call', { cmd, args, ...extra });
  if (!r.ok) die(r.error || 'command failed');
  return r.out;
};

function parseFlags(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt === undefined || nxt.startsWith('--')) flags[k] = true;
      else { flags[k] = nxt; i++; }
    } else pos.push(a);
  }
  return { flags, pos };
}

function parseDuration(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)s?$/i);
  if (!m) die(`bad duration "${s}" (use e.g. 30s, 10m, 2h, 1d)`);
  const mult = { s: 1, sec: 1, m: 60, min: 60, h: 3600, hr: 3600, d: 86400, day: 86400 }[m[2].toLowerCase()];
  return Number(m[1]) * mult * 1000;
}
function parseAt(s) {
  const hm = String(s).match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date();
    d.setHours(+hm[1], +hm[2], 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) die(`bad time "${s}" (use HH:MM or an ISO date like 2026-11-09T09:00)`);
  return t;
}

async function geocode(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=3&q=' + encodeURIComponent(q);
  let r;
  try { r = await fetch(url, { headers: { 'user-agent': 'pocket-ide-phone-cli/1.0', 'accept-language': 'en' } }); }
  catch (e) { die('geocoding failed (no internet?): ' + (e.cause?.code || e.message)); }
  if (!r.ok) die('geocoding failed: ' + r.status);
  const list = await r.json();
  if (!list.length) die(`place not found: ${q}`);
  return list.map((p) => ({ name: p.display_name, lat: +p.lat, lon: +p.lon }));
}

const [cmd, ...rest] = process.argv.slice(2);
const { flags, pos } = parseFlags(rest);

switch (cmd) {
  case undefined: case 'help': case '-h': case '--help': out(HELP); break;
  case 'status': out(await call('GET', '/status')); break;
  case 'location': out(await termux('location', ['-p', flags.gps ? 'gps' : 'network', '-r', 'once'], { timeout: 60000 })); break;
  case 'battery': out(await termux('battery-status')); break;
  case 'geocode': out(await geocode(pos.join(' ') || die('usage: phone geocode "<place>"'))); break;
  case 'notify': await termux('notification', ['--title', pos[0] || 'Pocket IDE', '--content', pos.slice(1).join(' ') || pos[0] || '']); out({ ok: true }); break;
  case 'toast': await termux('toast', [pos.join(' ')]); out({ ok: true }); break;
  case 'say': await termux('tts-speak', [pos.join(' ')]); out({ ok: true }); break;
  case 'vibrate': await termux('vibrate', ['-d', pos[0] || '500', '-f']); out({ ok: true }); break;
  case 'torch': await termux('torch', [pos[0] === 'off' ? 'off' : 'on']); out({ ok: true }); break;
  case 'clip':
    if (pos[0] === 'set') { await termux('clipboard-set', [], { input: pos.slice(1).join(' ') }); out({ ok: true }); }
    else out(await termux('clipboard-get'));
    break;
  case 'open': await termux('open-url', [pos[0] || die('usage: phone open <url>')]); out({ ok: true }); break;
  case 'volume': out(await termux('volume', pos)); break;
  case 'intent': {
    const r = await call('POST', '/intent', { args: rest });
    if (!r.ok) die(r.error);
    out(r);
    break;
  }
  case 'app': {
    const pkg = pos[0] || die('usage: phone app <package.name>   (e.g. com.whatsapp, com.google.android.apps.maps)');
    const r = await call('POST', '/intent', { args: ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', pkg] });
    if (!r.ok) {
      // Fallback: open the app's store page / deep link handler
      const r2 = await call('POST', '/intent', { args: ['-a', 'android.intent.action.VIEW', '-d', `market://launch?id=${pkg}`] });
      if (!r2.ok) die(r.error);
    }
    out({ ok: true });
    break;
  }
  case 'alarm': {
    // Real Android alarm in the Clock app: phone alarm 07:30 "Gym" [--days 2,3,4,5,6]
    const m = String(pos[0] || '').match(/^(\d{1,2}):(\d{2})$/) || die('usage: phone alarm HH:MM "label" [--days 2,3,4,5,6] (1=Sun)');
    const args = ['-a', 'android.intent.action.SET_ALARM',
      '--ei', 'android.intent.extra.alarm.HOUR', String(+m[1]), '--ei', 'android.intent.extra.alarm.MINUTES', String(+m[2]),
      '--es', 'android.intent.extra.alarm.MESSAGE', pos.slice(1).join(' ') || 'Alarm',
      '--ez', 'android.intent.extra.alarm.SKIP_UI', 'true'];
    if (flags.days) args.push('--eial', 'android.intent.extra.alarm.DAYS', String(flags.days));
    const r = await call('POST', '/intent', { args });
    if (!r.ok) die(r.error);
    out({ ok: true });
    break;
  }
  case 'whatsapp': case 'sms': {
    // phone whatsapp "<name or +number>" "<message>" -> opens the chat with the text filled in
    const who = pos[0] || die(`usage: phone ${cmd} "<contact name or +countrycode number>" "<message>"`);
    const text = pos.slice(1).join(' ');
    let number = who.replace(/[\s()-]/g, '');
    if (!/^\+?\d{6,}$/.test(number)) {
      const contacts = await termux('contact-list'); // needs allowSensitive in bridge-config.json
      const q = who.toLowerCase();
      const hits = (Array.isArray(contacts) ? contacts : []).filter((c) => (c.name || '').toLowerCase().includes(q));
      if (!hits.length) die(`no contact matching "${who}"`);
      if (hits.length > 1 && !hits.some((c) => c.name.toLowerCase() === q)) {
        out({ ambiguous: true, matches: hits.slice(0, 10).map((c) => ({ name: c.name, number: c.number })) });
        process.exit(2);
      }
      const c = hits.find((x) => x.name.toLowerCase() === q) || hits[0];
      number = c.number.replace(/[\s()-]/g, '');
      console.error(`phone: ${c.name} -> ${number}`);
    }
    const uri = cmd === 'whatsapp'
      ? `https://wa.me/${number.replace(/^\+/, '')}?text=${encodeURIComponent(text)}`
      : `smsto:${number}?body=${encodeURIComponent(text)}`;
    const r = await call('POST', '/intent', { args: ['-a', cmd === 'whatsapp' ? 'android.intent.action.VIEW' : 'android.intent.action.SENDTO', '-d', uri] });
    if (!r.ok) die(r.error);
    out({ ok: true, opened: uri, note: 'Message is pre-filled; the user taps Send.' });
    break;
  }
  case 'navigate': {
    const dest = pos.join(' ') || die('usage: phone navigate "<place or lat,lon>"');
    const r = await call('POST', '/intent', { args: ['-a', 'android.intent.action.VIEW', '-d', 'google.navigation:q=' + encodeURIComponent(dest)] });
    if (!r.ok) die(r.error);
    out({ ok: true });
    break;
  }
  case 'raw': out(await termux(pos[0] || die('usage: phone raw <termux-cmd> [args]'), rest.slice(1))); break;

  case 'geofence': {
    const sub = pos[0];
    if (sub === 'list' || !sub) out((await call('GET', '/automations')).geofences);
    else if (sub === 'rm') out(await call('DELETE', '/geofences/' + (pos[1] || die('usage: phone geofence rm <id>'))));
    else if (sub === 'add') {
      let { lat, lon, name } = flags;
      if (flags.place) {
        const [p] = await geocode(flags.place);
        lat = p.lat; lon = p.lon; name = name || flags.place;
        console.error(`phone: "${flags.place}" -> ${p.name} (${lat}, ${lon})`);
      }
      if (lat == null || lon == null) die('geofence add needs --place "<name>" or --lat/--lon');
      out(await call('POST', '/geofences', {
        name: name || `${lat},${lon}`, lat: +lat, lon: +lon, radius: flags.radius ? +flags.radius : 300,
        trigger: flags.exit ? 'exit' : 'enter', repeat: !!flags.repeat,
        message: flags.message === true ? undefined : flags.message, command: flags.command === true ? undefined : flags.command,
      }));
    } else die('usage: phone geofence add|list|rm');
    break;
  }
  case 'remind': {
    const sub = pos[0];
    if (sub === 'list') out((await call('GET', '/automations')).reminders);
    else if (sub === 'rm') out(await call('DELETE', '/reminders/' + (pos[1] || die('usage: phone remind rm <id>'))));
    else {
      const at = flags.in ? Date.now() + parseDuration(flags.in) : flags.at ? parseAt(flags.at) : die('remind needs --in or --at');
      const message = pos.join(' ') || 'Reminder';
      const r = await call('POST', '/reminders', {
        at, message, repeat: flags.repeat === true ? 'daily' : flags.repeat, speak: !!flags.speak,
        command: flags.command === true ? undefined : flags.command,
      });
      out({ ...r, atLocal: new Date(r.at).toString() });
    }
    break;
  }
  default: die(`unknown command "${cmd}". Run: phone help`);
}
