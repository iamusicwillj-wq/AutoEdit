#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="AutoEdit V0.3.9"
EXECUTABLE_NAME="AutoEdit"
VERSION="0.3.9"
BUILD_NUMBER="25"
APP_DIR="$ROOT_DIR/build/$APP_NAME.app"
ICON_SOURCE="$ROOT_DIR/Resources/AutoEditIcon.png"
ICONSET_DIR="$ROOT_DIR/.build/AutoEdit.iconset"
ICON_FILE="$ROOT_DIR/.build/AutoEdit.icns"

cd "$ROOT_DIR"
swift build -c release

BIN_DIR="$(swift build -c release --show-bin-path)"
BIN_PATH="$BIN_DIR/$EXECUTABLE_NAME"

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$BIN_PATH" "$APP_DIR/Contents/MacOS/$EXECUTABLE_NAME"
cp -R "$BIN_DIR/AutoEditApp_AutoEditApp.bundle" "$APP_DIR/Contents/Resources/"

rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"
sips -z 16 16 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET_DIR" -o "$ICON_FILE"
cp "$ICON_FILE" "$APP_DIR/Contents/Resources/AutoEdit.icns"

plist="$APP_DIR/Contents/Info.plist"
{
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
  printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  printf '%s\n' '<plist version="1.0">'
  printf '%s\n' '<dict>'
  printf '%s\n' '  <key>CFBundleDevelopmentRegion</key>'
  printf '%s\n' '  <string>en</string>'
  printf '%s\n' '  <key>CFBundleExecutable</key>'
  printf '%s\n' "  <string>$EXECUTABLE_NAME</string>"
  printf '%s\n' '  <key>CFBundleIdentifier</key>'
  printf '%s\n' '  <string>com.autoedit.prototype.v039</string>'
  printf '%s\n' '  <key>CFBundleIconFile</key>'
  printf '%s\n' '  <string>AutoEdit</string>'
  printf '%s\n' '  <key>CFBundleInfoDictionaryVersion</key>'
  printf '%s\n' '  <string>6.0</string>'
  printf '%s\n' '  <key>CFBundleName</key>'
  printf '%s\n' "  <string>$APP_NAME</string>"
  printf '%s\n' '  <key>CFBundlePackageType</key>'
  printf '%s\n' '  <string>APPL</string>'
  printf '%s\n' '  <key>CFBundleShortVersionString</key>'
  printf '%s\n' "  <string>$VERSION</string>"
  printf '%s\n' '  <key>CFBundleVersion</key>'
  printf '%s\n' "  <string>$BUILD_NUMBER</string>"
  printf '%s\n' '  <key>LSMinimumSystemVersion</key>'
  printf '%s\n' '  <string>14.0</string>'
  printf '%s\n' '  <key>NSHighResolutionCapable</key>'
  printf '%s\n' '  <true/>'
  printf '%s\n' '</dict>'
  printf '%s\n' '</plist>'
} > "$plist"

touch "$APP_DIR"
codesign --force --deep --sign - "$APP_DIR"

echo "Built $APP_DIR"
