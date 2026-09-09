#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

APP_DIR="build/TpTuner.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
WEB_DIR="$RESOURCES_DIR/web"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"
mkdir -p "$WEB_DIR"

swiftc -O -swift-version 5 -sdk "$(xcrun --show-sdk-path)" \
  -framework AppKit -framework WebKit -framework CoreBluetooth -framework IOKit \
  Sources/*.swift -o "$MACOS_DIR/TpTuner"

cp Info.plist "$CONTENTS_DIR/Info.plist"

cp ../tp-tuner/index.html "$WEB_DIR/index.html"
cp ../tp-tuner/tuner.js "$WEB_DIR/tuner.js"
if [ -d ../tp-tuner/dev ]; then
  cp -R ../tp-tuner/dev "$WEB_DIR/dev"
fi

codesign --force --sign - "$APP_DIR"

echo "ビルド完了: $APP_DIR"

if [ "${1:-}" = "--run" ]; then
  open "$APP_DIR"
fi
