#!/bin/bash
# CC Desk installer.  First install: ./install.sh    Update: ./install.sh --update  (the app's Update button runs this)
set -euo pipefail
cd "$(dirname "$0")"; DIR="$PWD"
APP="${CC_DESK_APP:-$HOME/Applications/CC Desk.app}"
UPDATE=$([ "${1:-}" = "--update" ] && echo 1 || echo 0)

[ "$(uname)" = Darwin ] || { echo "CC Desk is macOS only."; exit 1; }
command -v node >/dev/null || { echo "Needs Node.js 20+ (https://nodejs.org)."; exit 1; }
NV=$(node -v); NV=${NV#v}; [ "${NV%%.*}" -ge 20 ] 2>/dev/null || { echo "Needs Node.js 20+ (you have v$NV). Update from https://nodejs.org"; exit 1; }
command -v claude >/dev/null || { echo "Needs Claude Code installed first (https://docs.claude.com/en/docs/claude-code)."; exit 1; }
xcode-select -p >/dev/null 2>&1 || { echo "Needs Apple's command line tools: run  xcode-select --install  then try again."; exit 1; }

[ "$UPDATE" = 1 ] && git pull --ff-only
npm ci --ignore-scripts --no-audit --no-fund

# Electron binary (its own installer sometimes leaves a half-unpacked copy, so fall back to macOS's ditto)
EV=$(node -p "require('./node_modules/electron/package.json').version")
EBIN=node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
node node_modules/electron/install.js || true
if [ ! -x "$EBIN" ]; then
  ARCH=$(uname -m | sed 's/x86_64/x64/')
  Z=$(ls ~/Library/Caches/electron/*/"electron-v$EV-darwin-$ARCH.zip" 2>/dev/null | head -1)
  [ -n "$Z" ] || { echo "Electron download failed. Check your internet and run ./install.sh again."; exit 1; }
  rm -rf node_modules/electron/dist && mkdir node_modules/electron/dist && ditto -x -k "$Z" node_modules/electron/dist
  printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
fi
./node_modules/.bin/electron-rebuild -f -w node-pty

# App bundle: rebuilt only when missing or Electron changed. A renamed bundle keeps its name and icon.
HAVE=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$APP/Contents/Info.plist" 2>/dev/null || true)
if [ ! -d "$APP" ] || [ "$HAVE" != "$EV" ]; then
  NAME=$(basename "$APP" .app); TMPICON=$(mktemp -d)/icon.icns
  if [ -f "$APP/Contents/Resources/electron.icns" ]; then cp "$APP/Contents/Resources/electron.icns" "$TMPICON"
  else
    ICONSET=$(mktemp -d)/i.iconset; mkdir -p "$ICONSET"
    for z in 16 32 128 256 512; do sips -z $z $z cc-desk.png --out "$ICONSET/icon_${z}x${z}.png" >/dev/null
      sips -z $((z*2)) $((z*2)) cc-desk.png --out "$ICONSET/icon_${z}x${z}@2x.png" >/dev/null; done
    iconutil -c icns "$ICONSET" -o "$TMPICON"
  fi
  mkdir -p "$(dirname "$APP")"; rm -rf "$APP"
  ditto node_modules/electron/dist/Electron.app "$APP"
  PL="$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName $NAME" "$PL"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $NAME" "$PL" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $NAME" "$PL"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier io.github.ccdesk.$(echo "$NAME" | tr -cd 'a-zA-Z0-9' | tr 'A-Z' 'a-z')" "$PL"
  cp "$TMPICON" "$APP/Contents/Resources/electron.icns"
  rm -f "$APP/Contents/Resources/default_app.asar"
  ln -s "$DIR" "$APP/Contents/Resources/app"
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1
fi
node check.js >/dev/null && echo "✓ CC Desk ready: open \"$APP\" (or ⌘ Space → $(basename "$APP" .app))"
