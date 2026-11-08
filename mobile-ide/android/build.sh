#!/usr/bin/env bash
# Builds the Pocket IDE APK with the plain Android SDK tools (no Gradle needed).
#
#   ANDROID_HOME=~/android-sdk ./build.sh                 # -> build/pocket-ide.apk
#   VERSION_CODE=42 VERSION_NAME=1.0.42 ./build.sh        # CI sets these from the run number
#
# Signing: uses KEYSTORE / KEYSTORE_PASS / KEY_ALIAS if set, otherwise the
# bundled dev keystore (fine for sideloading; use your own for public builds).
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
PLATFORM="${PLATFORM:-android-34}"
BT_VER="${BUILD_TOOLS:-$(ls "$SDK/build-tools" | sort -V | tail -1)}"
BT="$SDK/build-tools/$BT_VER"
JAR="$SDK/platforms/$PLATFORM/android.jar"
VERSION_CODE="${VERSION_CODE:-1}"
VERSION_NAME="${VERSION_NAME:-1.0.$VERSION_CODE}"
KEYSTORE="${KEYSTORE:-keystore/pocket-ide-dev.jks}"
KEYSTORE_PASS="${KEYSTORE_PASS:-pocketide}"
KEY_ALIAS="${KEY_ALIAS:-pocketide}"
OUT=build

[ -f "$JAR" ] || { echo "missing $JAR (install with: sdkmanager \"platforms;$PLATFORM\")" >&2; exit 1; }
[ -x "$BT/aapt2" ] || { echo "missing build-tools in $SDK/build-tools" >&2; exit 1; }
echo "SDK=$SDK build-tools=$BT_VER platform=$PLATFORM version=$VERSION_NAME ($VERSION_CODE)"

rm -rf "$OUT" && mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

# Bundle the Termux-side installer + prebuilt IDE into the APK (served on 127.0.0.1:8786).
# The IDE is shipped prebuilt (dist/server.mjs + public/dist) so phones never need
# `npm install`, which is unreliable under proot.
if [ ! -f ../dist/server.mjs ] || [ ! -f ../public/dist/main.js ] || [ -n "${REBUILD_WEB:-}" ]; then
  (cd .. && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm run build)
fi
mkdir -p assets/payload
cp ../termux-setup.sh assets/payload/setup.sh
tar czf assets/payload/pocket-ide.tar.gz -C .. \
  --exclude=node_modules --exclude=android \
  package.json package-lock.json build.js server.js pty-helper.py dist client public bridge templates termux-setup.sh README.md
cp assets/payload/pocket-ide.tar.gz "$OUT/pocket-ide.tar.gz"   # also published with each release
echo "payload: $(du -h assets/payload/pocket-ide.tar.gz | cut -f1)"

"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/unsigned.apk" -I "$JAR" \
  --manifest AndroidManifest.xml -A assets --java "$OUT/gen" \
  --min-sdk-version 26 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  "$OUT/res.zip"

javac -encoding UTF-8 --release 8 -nowarn -classpath "$JAR" -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java') 2>&1 | grep -v 'Picked up JAVA_TOOL_OPTIONS' || true
[ -n "$(find "$OUT/classes" -name '*.class' | head -1)" ] || { echo "javac failed" >&2; exit 1; }

"$BT/d8" --release --min-api 26 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q -j ../unsigned.apk classes.dex)

"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass "pass:$KEYSTORE_PASS" --ks-key-alias "$KEY_ALIAS" \
  --out "$OUT/pocket-ide.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify "$OUT/pocket-ide.apk"
rm -f "$OUT/pocket-ide.apk.idsig"
echo "Built $(pwd)/$OUT/pocket-ide.apk ($(du -h "$OUT/pocket-ide.apk" | cut -f1))"
