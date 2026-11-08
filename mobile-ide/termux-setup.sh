#!/data/data/com.termux/files/usr/bin/bash
# Pocket IDE: one-command installer for Android (run inside Termux).
#
#   curl -fsSLo pocket-setup.sh https://raw.githubusercontent.com/sasivisvan/cpp_backend_chat_application/claude/tender-bardeen-qyata4/mobile-ide/termux-setup.sh && bash pocket-setup.sh
#
# Why Ubuntu-in-Termux? Claude Code ships native binaries only for regular Linux,
# macOS and Windows. Plain Termux reports itself as "android" and the install
# fails ("Native binaries for linux-arm64-android are not available"). Inside a
# proot Ubuntu, Claude Code sees normal arm64 Linux and installs fine.
#
# Layout:
#   Termux (native)  -> phone-bridge.js  (Termux:API: GPS, notifications, …)
#   Ubuntu (proot)   -> Pocket IDE server + Claude Code + your projects
#   Both share 127.0.0.1, so the IDE and the `phone` CLI reach the bridge.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/sasivisvan/cpp_backend_chat_application.git}"
BRANCH="${BRANCH:-claude/tender-bardeen-qyata4}"
DISTRO="${DISTRO:-ubuntu}"
SRC="$HOME/pocket-ide-src"
APP="$SRC/mobile-ide"
ROOTFS="$PREFIX/var/lib/proot-distro/installed-rootfs/$DISTRO"

say() { printf '\n\033[1;38;5;173m==> %s\033[0m\n' "$*"; }

if [ -z "${PREFIX:-}" ] || [ ! -d "$PREFIX" ]; then
  echo "This script must be run inside Termux on Android." >&2
  exit 1
fi

# Where the code comes from:
#   POCKET_SRC_FILE set -> an already-downloaded tarball (what the Android app's setup
#                          command does: it fetches from the app without needing curl)
#   POCKET_SRC_URL set  -> a tarball URL (e.g. http://127.0.0.1:8786/pocket-ide.tar.gz)
#   otherwise           -> git clone from GitHub
if [ -n "${POCKET_SRC_URL:-}" ] && [ -z "${POCKET_SRC_FILE:-}" ]; then
  POCKET_SRC_FILE="${TMPDIR:-$PREFIX/tmp}/pocket-ide.tar.gz"
  curl -fsSL "$POCKET_SRC_URL" -o "$POCKET_SRC_FILE"
fi
if [ -n "${POCKET_SRC_FILE:-}" ]; then
  say "1/6  Unpacking Pocket IDE (bundled with the app)"
  [ -s "$POCKET_SRC_FILE" ] || { echo "Source tarball $POCKET_SRC_FILE is missing or empty. Keep the Pocket IDE app open and retry." >&2; exit 1; }
  rm -rf "$SRC.new" && mkdir -p "$SRC.new/mobile-ide"
  tar xzf "$POCKET_SRC_FILE" -C "$SRC.new/mobile-ide"
  rm -rf "$SRC" && mv "$SRC.new" "$SRC"
fi

say "2/6  Repairing / upgrading Termux packages"
# A half-upgraded Termux breaks binaries with errors like
#   CANNOT LINK EXECUTABLE "node": cannot locate symbol "_ZNSt6__ndk1…"
#   CANNOT LINK EXECUTABLE "curl": cannot locate symbol "SSL_set_quic_…"
# The cure is a full upgrade (plain apt, which doesn't depend on curl).
APT_OPTS=(-y -o Dpkg::Options::=--force-confnew -o Dpkg::Options::=--force-confdef)
works() { "$@" >/dev/null 2>&1; }
if ! apt update; then
  echo >&2
  echo "Could not reach the Termux package mirror. Run:  termux-change-repo" >&2
  echo "pick a different mirror, then run this setup again." >&2
  exit 1
fi
apt full-upgrade "${APT_OPTS[@]}" || { apt install "${APT_OPTS[@]}" openssl; apt full-upgrade "${APT_OPTS[@]}"; }
apt install "${APT_OPTS[@]}" git curl nodejs-lts termux-api proot-distro
if ! works curl --version; then
  say "     curl is broken, reinstalling it with OpenSSL"
  apt install --reinstall "${APT_OPTS[@]}" openssl libcurl curl
fi
if ! works node -v; then
  say "     node is broken, reinstalling it with its C++ runtime"
  apt install --reinstall "${APT_OPTS[@]}" libc++ nodejs-lts
fi
for b in curl node; do
  works "$b" --version || { echo "Termux's $b still won't start. Try: termux-change-repo, then run setup again." >&2; exit 1; }
done
echo "Termux OK: $(node -v), $(curl --version | head -1 | cut -d' ' -f1-2)"

if [ -z "${POCKET_SRC_FILE:-}" ]; then
  say "     Fetching Pocket IDE from GitHub"
  if [ -d "$SRC/.git" ]; then
    git -C "$SRC" fetch --depth 1 origin "$BRANCH" && git -C "$SRC" reset --hard FETCH_HEAD
  else
    # ~/pocket-ide-src only holds Pocket IDE's own code (projects live in Ubuntu's
    # /root/projects), so a leftover copy from an app-based install can go.
    rm -rf "$SRC"
    git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$SRC"
  fi
fi

say "3/6  Creating shared access token"
mkdir -p "$HOME/.pocket-ide"
if [ ! -s "$HOME/.pocket-ide/token" ]; then
  od -An -N16 -tx1 /dev/urandom | tr -d ' \n' > "$HOME/.pocket-ide/token"
  chmod 600 "$HOME/.pocket-ide/token"
fi

say "4/6  Installing Ubuntu (first time takes a few minutes)"
if [ ! -d "$ROOTFS" ]; then
  proot-distro install "$DISTRO"
fi
mkdir -p "$ROOTFS/root/.pocket-ide" "$ROOTFS/opt/pocket-ide" "$ROOTFS/root/projects"
cp "$HOME/.pocket-ide/token" "$ROOTFS/root/.pocket-ide/token"
# Copy the app (without build outputs) into Ubuntu.
(cd "$APP" && tar cf - --exclude=node_modules --exclude=public/dist .) | (cd "$ROOTFS/opt/pocket-ide" && tar xf -)
[ -f "$ROOTFS/root/projects/CLAUDE.md" ] || cp "$APP/templates/CLAUDE.md" "$ROOTFS/root/projects/CLAUDE.md"

say "5/6  Installing Node.js, build tools and Claude Code inside Ubuntu"
proot-distro login "$DISTRO" -- bash -s <<'UBUNTU'
set -e
# proot-distro appends Termux's bin dirs to PATH. Termux binaries are Android
# builds that can't run here, so use Ubuntu's own PATH only.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates git build-essential python3 nano less ripgrep
node_major() { if [ -x /usr/bin/node ]; then /usr/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; else echo 0; fi; }
if [ "$(node_major)" -lt 20 ]; then
  apt-get install -y nodejs npm || true          # Ubuntu's own Node (22+ on recent releases)
fi
if [ "$(node_major)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Ubuntu node: $(/usr/bin/node -v)"
export PATH=/root/.local/bin:$PATH
# npm's cache is flaky under proot ("ENOENT … rename … _cacache"): retry with a
# fresh cache each time.
export npm_config_cache=/root/.cache/pocket-npm npm_config_fund=false npm_config_audit=false \
       npm_config_fetch_retries=5 npm_config_update_notifier=false
npm_retry() {
  for i in 1 2 3 4; do
    "$@" && return 0
    echo "npm failed (attempt $i/4), clearing the npm cache and retrying..."
    rm -rf "$npm_config_cache" /root/.npm/_cacache
    sleep 3
  done
  return 1
}
if ! command -v claude >/dev/null; then
  if ! npm_retry npm install -g @anthropic-ai/claude-code; then
    echo "npm install of Claude Code failed; trying the official installer instead"
    curl -fsSL https://claude.ai/install.sh | bash
  fi
fi
claude --version || echo "warning: claude did not start; see README troubleshooting"
cd /opt/pocket-ide
npm_retry npm install
npm run build
printf '#!/bin/sh\nexec node /opt/pocket-ide/bridge/phone.mjs "$@"\n' > /usr/local/bin/phone
chmod +x /usr/local/bin/phone
UBUNTU

say "6/6  Creating launchers"
cat > "$PREFIX/bin/pocket-bridge" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# Phone bridge (Termux side). Keeps automations running.
termux-wake-lock 2>/dev/null || true
exec node "$APP/bridge/phone-bridge.js"
EOF

cat > "$PREFIX/bin/pocket-ide" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# Start the phone bridge (if needed) and the IDE, then open it.
#   pocket-ide         open in the browser
#   pocket-ide --app   open in the Pocket IDE Android app (used by the app's Start button)
termux-wake-lock 2>/dev/null || true
if ! pgrep -f phone-bridge.js >/dev/null; then
  nohup node "$APP/bridge/phone-bridge.js" >> "\$HOME/.pocket-ide/bridge.out" 2>&1 &
fi
TOKEN=\$(cat "\$HOME/.pocket-ide/token")
PORT=\${PORT:-8787}
open_ide() {
  if [ "\${1:-}" = "--app" ]; then
    am start -a android.intent.action.VIEW -d "pocketide://open?token=\$TOKEN" >/dev/null 2>&1
  else
    termux-open-url "http://127.0.0.1:\$PORT/?token=\$TOKEN"
  fi
}
up() { curl -s -m 1 -o /dev/null "http://127.0.0.1:\$PORT/manifest.webmanifest"; }
if up; then open_ide "\${1:-}"; exit 0; fi   # already running
( for i in \$(seq 1 120); do sleep 1; if up; then open_ide "\${1:-}"; break; fi; done ) &
exec proot-distro login $DISTRO --shared-tmp -- env IDE_TOKEN="\$TOKEN" PORT="\$PORT" WORKSPACE=/root/projects \\
  PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\
  bash -c 'cd /opt/pocket-ide && exec node server.js'
EOF

cat > "$PREFIX/bin/pocket-update" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# Reinstall Pocket IDE from the newest source (your projects are untouched).
# Prefers the copy bundled in the Pocket IDE app (open the app first); falls back to GitHub.
fetch() { exec 3<>/dev/tcp/127.0.0.1/8786 && printf 'GET /%s.raw HTTP/1.0\\r\\n\\r\\n' "\$1" >&3 && cat <&3 > "\$2"; local r=\$?; exec 3<&-; return \$r; }
mkdir -p "\$HOME/.pocket-ide"
if fetch setup.sh "\$HOME/.pocket-ide/setup.sh" 2>/dev/null && fetch pocket-ide.tar.gz "\$HOME/.pocket-ide/src.tar.gz" && [ -s "\$HOME/.pocket-ide/src.tar.gz" ]; then
  POCKET_SRC_FILE="\$HOME/.pocket-ide/src.tar.gz" bash "\$HOME/.pocket-ide/setup.sh"
else
  echo "Pocket IDE app not reachable; updating from GitHub"
  curl -fsSLo "\$TMPDIR/pocket-setup.sh" "https://raw.githubusercontent.com/Sasivisvan/cpp_backend_chat_application/$BRANCH/mobile-ide/termux-setup.sh" && bash "\$TMPDIR/pocket-setup.sh"
fi
EOF
chmod +x "$PREFIX/bin/pocket-bridge" "$PREFIX/bin/pocket-ide" "$PREFIX/bin/pocket-update"

# Optional: start the bridge on boot if the Termux:Boot app is installed.
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/pocket-bridge" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
nohup node "$APP/bridge/phone-bridge.js" >> "\$HOME/.pocket-ide/bridge.out" 2>&1 &
EOF
chmod +x "$HOME/.termux/boot/pocket-bridge"

say "Done!"
cat <<'MSG'

  Start everything:      pocket-ide
  (opens http://127.0.0.1:8787 in your browser; use "Add to Home screen" to get an app icon)

  First time in the Claude tab: Claude Code prints a login link. Tap it, sign in,
  and paste the code back into the terminal.

  Make sure the "Termux:API" app (from F-Droid, same source as Termux) is installed and
  has Location + Notification permissions, or the phone commands won't work.
  Try:  phone notify "Hello" "from Pocket IDE"   (in the IDE terminal)

MSG
