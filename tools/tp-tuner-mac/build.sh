#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUILD_NUMBER=0
DO_RUN=0
DO_INSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --run)
      DO_RUN=1
      shift
      ;;
    --install)
      DO_INSTALL=1
      shift
      ;;
    --build)
      BUILD_NUMBER="$2"
      shift 2
      ;;
    *)
      echo "不明な引数: $1" >&2
      exit 1
      ;;
  esac
done

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
VERSION="$(cat VERSION)"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$CONTENTS_DIR/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$CONTENTS_DIR/Info.plist"

ICON_WORK_DIR="$(mktemp -d)"
ICON_PNG="$ICON_WORK_DIR/icon-1024.png"
ICONSET_DIR="$ICON_WORK_DIR/AppIcon.iconset"
mkdir -p "$ICONSET_DIR"
swift Icon/make-icon.swift "$ICON_PNG"
for base_size in 16 32 128 256 512; do
  sips -z "$base_size" "$base_size" "$ICON_PNG" --out "$ICONSET_DIR/icon_${base_size}x${base_size}.png" >/dev/null
  double_size=$((base_size * 2))
  sips -z "$double_size" "$double_size" "$ICON_PNG" --out "$ICONSET_DIR/icon_${base_size}x${base_size}@2x.png" >/dev/null
done
cp "$ICON_PNG" "$ICONSET_DIR/icon_512x512@2x.png"
iconutil -c icns "$ICONSET_DIR" -o "Icon/AppIcon.icns"
rm -rf "$ICON_WORK_DIR"
cp "Icon/AppIcon.icns" "$RESOURCES_DIR/AppIcon.icns"

cp ../tp-tuner/index.html "$WEB_DIR/index.html"
for f in ../tp-tuner/*.js; do
  case "$f" in *.test.js) ;; *) cp "$f" "$WEB_DIR/";; esac
done
if [ -d ../tp-tuner/dev ]; then
  cp -R ../tp-tuner/dev "$WEB_DIR/dev"
fi

codesign --force --sign - "$APP_DIR"

echo "ビルド完了: $APP_DIR (version $VERSION, build $BUILD_NUMBER)"

if [ "$DO_INSTALL" = "1" ]; then
  rm -rf /Applications/TpTuner.app
  ditto "$APP_DIR" /Applications/TpTuner.app
  echo "インストール完了: /Applications/TpTuner.app"
fi

if [ "$DO_RUN" = "1" ]; then
  open "$APP_DIR"
fi
