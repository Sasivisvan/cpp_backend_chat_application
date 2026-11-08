# Pocket IDE

A mobile code IDE that runs **on your Android phone**. It has a file explorer, a code editor,
real Linux terminals, **Claude Code** and a live app preview. Claude can also **control the
phone**: GPS, notifications, location triggers, reminders, speech, flashlight and more.

> "Remind me to buy milk when I reach Anna Nagar" → Claude looks up the place and registers a
> background location trigger. Your phone notifies you when you arrive.

| Tab | What it does |
|---|---|
| 📁 **Files** | Browse, create, rename and delete files in `~/projects` (long-press for actions) |
| 📝 **Code** | CodeMirror editor with syntax highlighting (JS/TS, Python, C/C++, HTML, CSS, JSON, Markdown, Java, Rust), tabs, search, Ctrl+S |
| ⌨️ **Terminal** | Real bash shells (several tabs). `apt`, `git`, `node`, `python`, `gcc`… just like a PC |
| ✳️ **Claude** | Claude Code CLI in a terminal, with a comfortable prompt box and quick actions |
| 📱 **Phone** | Phone bridge status, quick tests, and every automation Claude created (delete them here) |
| 🌐 **Preview** | View the app you're building (`localhost:3000` etc.). Links to localhost printed in a terminal open here |

A touch keybar (Esc, Tab, Ctrl, Alt, arrows, `|`, `~`, ^C, Paste) sits above the keyboard in the
terminal tabs. Terminal sessions keep running when you switch apps or lock the phone. When you
come back, they reconnect and replay their output.

## Android app (APK)

**Download the latest:**
https://github.com/sasivisvan/cpp_backend_chat_application/releases/latest/download/pocket-ide.apk
(a copy of the current build is also in [`android/release/pocket-ide.apk`](android/release/pocket-ide.apk)).

The app is the front door to everything below:

- a **setup checklist**: install Termux and Termux:API, copy the one-line setup command, grant permissions
- a **Start** button that launches Ubuntu, the IDE and the phone bridge in Termux, then shows the
  IDE full-screen
- **auto-updates**: on launch it checks GitHub's latest release and offers a one-tap download
  and install. ⋮ → *Check for app update* checks manually. *Update IDE in Termux* runs
  `pocket-update`.

**How releases happen:** every push that changes `mobile-ide/` runs
[`.github/workflows/pocket-ide-release.yml`](../.github/workflows/pocket-ide-release.yml). It
builds the APK with version `1.0.<run number>` and publishes it as the newest GitHub release, so
the link above always serves the latest build. To build locally: `ANDROID_HOME=~/android-sdk android/build.sh`.

> Signing: builds use the bundled **dev keystore** (`android/keystore/`) so every build can update
> the previous one. That key is public. Before distributing widely, create your own keystore and
> add it as the repo secrets `POCKET_IDE_KEYSTORE_B64`, `POCKET_IDE_KEYSTORE_PASS` and
> `POCKET_IDE_KEY_ALIAS`. Switching keys means uninstalling the old app once.

## Install on Android (Termux part)

**Why not plain Termux?** Current Claude Code releases are native binaries built for regular
Linux, macOS and Windows. Termux identifies as `android`, and no Android build is published, so
`npm i -g @anthropic-ai/claude-code` fails there. Pocket IDE avoids this by running Claude Code
inside an **Ubuntu userland in Termux** (`proot-distro`). There Claude Code sees ordinary arm64
Linux. The installer handles all of this for you.

1. Install **Termux** and **Termux:API** from **F-Droid**. Both must come from the same source;
   the Play Store version of Termux is outdated. Optionally add **Termux:Boot** so automations
   restart after a reboot.
2. Open Termux:API once and grant **Location** (choose "Allow all the time" for background
   location triggers) and **Notifications**.
3. **Easiest:** install the APK, open it, and tap **Copy & open Termux** in step 3. That
   command installs everything from the copy bundled inside the app, so it works even while
   the GitHub repo is private. Without the app, run this in Termux (the repo must be public):

   ```bash
   curl -fsSLo pocket-setup.sh https://raw.githubusercontent.com/sasivisvan/cpp_backend_chat_application/claude/tender-bardeen-qyata4/mobile-ide/termux-setup.sh && bash pocket-setup.sh
   ```

   Setup takes about 5–15 minutes and roughly 1.5 GB of storage (Ubuntu, Node and build tools).

4. Start it:

   ```bash
   pocket-ide
   ```

   Your browser opens the IDE. Use the browser menu → **Add to Home screen** to get an app icon
   that opens full-screen.
5. Open the **Claude** tab. On first launch Claude Code shows a login link. Tap it, sign in, and
   paste the code back.

Other commands: `pocket-bridge` runs just the phone bridge, and `pocket-update` updates Pocket IDE
without touching your projects.

### Keep Android from killing it

- Run `termux-wake-lock` (the launchers do this) and set Termux to **Unrestricted** battery usage
  in Android settings.
- On **Android 12+**, Android's "phantom process killer" may stop background processes. On
  Android 14+, turn on Developer options → **Disable child process restrictions**. On Android
  12–13, run this once from a PC:
  `adb shell device_config put activity_manager max_phantom_processes 2147483647`

## Phone control

The `phone` command works in any IDE terminal and is what Claude uses. The workspace's
`CLAUDE.md` teaches Claude how to use it. Run `phone help` for the full list:

```bash
phone location            phone battery          phone geocode "Marina Beach"
phone notify "T" "Body"   phone say "Hello"      phone vibrate 500    phone torch on
phone open "geo:13.05,80.28?q=Marina"            phone raw sensor -s light -n 1

phone geofence add --place "Anna Nagar, Chennai" --message "Buy milk"   # arrive
phone geofence add --lat 13.0 --lon 80.2 --name Office --exit           # leave
phone remind --in 20m "Tea"         phone remind --at 07:00 --repeat daily --speak "Wake up"
phone geofence list | rm <id>       phone remind list | rm <id>
```

Apps and messages (Android intents):

```bash
phone app com.spotify.music                  phone alarm 06:30 "Gym" --days 2,3,4,5,6
phone navigate "Chennai Central"             phone whatsapp "Ravi" "Running 10 min late"
phone sms "+919876543210" "Reached"          phone intent -a android.intent.action.VIEW -d "https://…"
```

So you can say *"tell Ravi on WhatsApp I'm running late"*, *"set an alarm for 6:30 on weekdays"*,
*"navigate home"* or *"every night at 10 turn the ringer off"*, and Claude writes and runs the code.

What it **can't** do yet: WhatsApp and SMS messages are **pre-filled, and you tap Send**. WhatsApp
has no API for personal accounts. Sending fully automatically, or tapping buttons inside other
apps, needs Android's Accessibility service, which only a native app can use (see Roadmap).
To open apps while Termux is in the background, give Termux the **Display over other apps**
permission. Contact-name lookup needs `allowSensitive` (below).

Automations live in the **bridge**, a small dependency-free Node service in native Termux. They
keep running after you close the IDE, and they show up in the **Phone** tab. Location triggers use
adaptive polling: rare low-power network fixes when you're far away, GPS only near the edge of a
trigger. They don't sit in a loop draining the battery.

### Privacy and safety

- Everything listens on `127.0.0.1` only and needs a random token (`~/.pocket-ide/token`).
- The bridge only runs **allowlisted** Termux:API commands. Commands that read private data or
  contact people (`sms-send`, `sms-list`, `contact-list`, `call-log`, `telephony-call`,
  `camera-photo`, `microphone-record`, `notification-list`) are **off** by default. To enable
  them, add the following to `~/.pocket-ide/bridge-config.json` in Termux and restart the bridge:
  ```json
  { "allowSensitive": true }
  ```
- Claude Code still asks before running commands, unless you change its permission mode.

## Use it from a PC, server or iPhone (optional)

The IDE is a normal Node app, so you can also run it on a computer or VPS and use your phone as
the screen. Phone control needs Termux, so it only works on Android.

```bash
cd mobile-ide && npm install && npm run build
HOST=0.0.0.0 WORKSPACE=~/projects node server.js     # prints LAN URLs with the token
```

Use a private network such as Tailscale or WireGuard, or a reverse proxy with HTTPS, rather than
exposing the port to the internet.

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | IDE port |
| `HOST` | `127.0.0.1` | bind address (`0.0.0.0` for LAN) |
| `WORKSPACE` | `~/projects` | folder the IDE can see |
| `IDE_TOKEN` | random | access token |
| `IDE_SHELL` | `$SHELL` | shell for terminals |
| `PHONE_BRIDGE_URL` | `http://127.0.0.1:8788` | bridge address |

## Architecture

```
┌──────────── Android phone ─────────────────────────────────────────────┐
│  Browser / home-screen app (PWA)                                       │
│     │  HTTP + WebSocket (127.0.0.1:8787, token)                        │
│  ┌──▼───────────── Ubuntu (proot-distro) ──────────┐                   │
│  │  server.js: files API · PTY terminals (node-pty) │                   │
│  │  claude (Claude Code) · your projects · `phone`  │                   │
│  └──┬───────────────────────────────────────────────┘                   │
│     │  HTTP (127.0.0.1:8788, token)                                    │
│  ┌──▼──────────── Termux (native) ─────────────────┐   Termux:API app  │
│  │  phone-bridge.js: allowlist · geofences ·        │──► GPS, notify,   │
│  │  reminders · hooks                               │    TTS, torch …   │
│  └──────────────────────────────────────────────────┘                   │
└────────────────────────────────────────────────────────────────────────┘
```

## Troubleshooting

- **`phone: cannot reach the phone bridge`**: run `pocket-bridge` in a Termux session, or restart
  with `pocket-ide`.
- **Location returns nothing**: check that Termux:API has location permission and that location
  is on. Indoors, `phone location` (network) works better than `--gps`.
- **Claude Code fails to start in Ubuntu**: try `npm i -g @anthropic-ai/claude-code@latest`, or
  the native installer `curl -fsSL https://claude.ai/install.sh | bash` inside
  `proot-distro login ubuntu`.
- **Terminal is cut off by the keyboard**: rotate once, or use Chrome. The layout follows the
  visual viewport.

## Roadmap: a standalone APK

This version uses Termux so it works today without app-store builds. The next step is a single
APK that bundles a proot rootfs and exposes Android APIs natively (GeofencingClient, AlarmManager,
Intents, AccessibilityService and optionally Shizuku) in place of polling through Termux:API.
