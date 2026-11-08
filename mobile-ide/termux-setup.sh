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

say "1/6  Installing Termux packages (git, node, termux-api, proot-distro)"
pkg update -y -o Dpkg::Options::=--force-confnew
pkg install -y -o Dpkg::Options::=--force-confnew git nodejs-lts termux-api proot-distro

say "2/6  Fetching Pocket IDE"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch --depth 1 origin "$BRANCH" && git -C "$SRC" reset --hard FETCH_HEAD
else
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$SRC"
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
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates git build-essential python3 nano less ripgrep
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - || true
  apt-get install -y nodejs
fi
node -v
npm install -g @anthropic-ai/claude-code
claude --version || echo "warning: claude did not start; see README troubleshooting"
cd /opt/pocket-ide
npm install --no-audit --no-fund
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
# Start the phone bridge (if needed) and the IDE, then open it in the browser.
termux-wake-lock 2>/dev/null || true
if ! pgrep -f phone-bridge.js >/dev/null; then
  nohup node "$APP/bridge/phone-bridge.js" >> "\$HOME/.pocket-ide/bridge.out" 2>&1 &
fi
TOKEN=\$(cat "\$HOME/.pocket-ide/token")
PORT=\${PORT:-8787}
( sleep 3; termux-open-url "http://127.0.0.1:\$PORT/?token=\$TOKEN" ) &
exec proot-distro login $DISTRO --shared-tmp -- env IDE_TOKEN="\$TOKEN" PORT="\$PORT" WORKSPACE=/root/projects \\
  bash -lc 'cd /opt/pocket-ide && exec node server.js'
EOF

cat > "$PREFIX/bin/pocket-update" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# Pull the latest Pocket IDE and rebuild (your projects are untouched).
curl -fsSLo "\$TMPDIR/pocket-setup.sh" "https://raw.githubusercontent.com/sasivisvan/cpp_backend_chat_application/$BRANCH/mobile-ide/termux-setup.sh" && bash "\$TMPDIR/pocket-setup.sh"
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
