#!/usr/bin/env bash
set -euo pipefail

APP_NAME="AutoEdit V0.3.9"
EXECUTABLE_NAME="AutoEdit"
VERSION="0.3.9"
NODE_VERSION="v24.19.0"

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$APP_ROOT/.." && pwd)"
RUNNER_SOURCE="$WORKSPACE_ROOT/tools/ptsl-runner"
DIST_DIR="$APP_ROOT/dist"
APP_DIR="$DIST_DIR/$APP_NAME.app"
RUNNER_BUNDLE="$APP_DIR/Contents/Resources/ptsl-runner"
STAGING_DIR="$DIST_DIR/dmg-root"
CACHE_DIR="$DIST_DIR/cache"
ICONSET_DIR="$DIST_DIR/AutoEdit.iconset"
ICON_FILE="$DIST_DIR/AutoEdit.icns"
DMG_PATH="$DIST_DIR/AutoEdit-$VERSION-macOS-universal.dmg"

for command in swift curl tar lipo hdiutil sips iconutil npm node; do
  command -v "$command" >/dev/null || {
    echo "Missing build dependency: $command" >&2
    exit 1
  }
done

rm -rf "$APP_DIR" "$STAGING_DIR" "$ICONSET_DIR" "$ICON_FILE" "$DMG_PATH"
mkdir -p "$APP_DIR/Contents/MacOS" \
  "$RUNNER_BUNDLE/src" \
  "$APP_DIR/Contents/Resources/node/bin" \
  "$APP_DIR/Contents/Resources/Third-Party-Licenses" \
  "$CACHE_DIR" "$STAGING_DIR"

echo "Building universal Swift executable..."
(
  cd "$APP_ROOT"
  swift build -c release --arch arm64 --arch x86_64
)
SWIFT_BIN="$APP_ROOT/.build/apple/Products/Release/$EXECUTABLE_NAME"
[[ -x "$SWIFT_BIN" ]] || {
  echo "Universal Swift executable was not produced at $SWIFT_BIN" >&2
  exit 1
}
cp "$SWIFT_BIN" "$APP_DIR/Contents/MacOS/$EXECUTABLE_NAME"
cp -R "$APP_ROOT/.build/apple/Products/Release/AutoEditApp_AutoEditApp.bundle" "$APP_DIR/Contents/Resources/"

echo "Preparing production runner dependencies..."
cp "$RUNNER_SOURCE/package.json" "$RUNNER_SOURCE/package-lock.json" \
  "$RUNNER_BUNDLE/"
cp "$RUNNER_SOURCE"/src/*.js "$RUNNER_BUNDLE/src/"
(
  cd "$RUNNER_BUNDLE"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
)
echo "Preparing universal Node.js runtime..."
for arch in arm64 x64; do
  archive="node-$NODE_VERSION-darwin-$arch.tar.gz"
  url="https://nodejs.org/dist/$NODE_VERSION/$archive"
  if [[ ! -f "$CACHE_DIR/$archive" ]]; then
    curl -fL "$url" -o "$CACHE_DIR/$archive"
  fi
  rm -rf "$CACHE_DIR/node-$NODE_VERSION-darwin-$arch"
  tar -xzf "$CACHE_DIR/$archive" -C "$CACHE_DIR"
done
lipo -create \
  "$CACHE_DIR/node-$NODE_VERSION-darwin-arm64/bin/node" \
  "$CACHE_DIR/node-$NODE_VERSION-darwin-x64/bin/node" \
  -output "$APP_DIR/Contents/Resources/node/bin/node"
chmod 755 "$APP_DIR/Contents/Resources/node/bin/node"
cp "$CACHE_DIR/node-$NODE_VERSION-darwin-arm64/LICENSE" \
  "$APP_DIR/Contents/Resources/Third-Party-Licenses/Node-LICENSE.txt"
cp "$WORKSPACE_ROOT/LICENSE" "$APP_DIR/Contents/Resources/AutoEdit-LICENSE.txt"

echo "Generating app icon..."
mkdir -p "$ICONSET_DIR"
ICON_SOURCE="$APP_ROOT/Resources/AutoEditIcon.png"
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

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>$EXECUTABLE_NAME</string>
  <key>CFBundleIdentifier</key><string>com.autoedit.prototype.v039</string>
  <key>CFBundleIconFile</key><string>AutoEdit</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>25</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Ad-hoc signing is not identity signing or notarization. It keeps the nested
# universal executable acceptable to macOS after lipo creates it.
codesign --force --sign - "$APP_DIR/Contents/Resources/node/bin/node"
codesign --force --deep --sign - "$APP_DIR"

if [[ "${1:-}" == "--app-only" ]]; then
  echo "Built $APP_DIR"
  exit 0
fi

cp -R "$APP_DIR" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"
cat > "$STAGING_DIR/Install - 安装说明.txt" <<'INSTRUCTIONS'
AutoEdit v0.3.9 prerelease / 测试候选版

1. Drag AutoEdit V0.3.9 to Applications. macOS 14 or later is required.
2. Obtain the Pro Tools Scripting SDK 2025.10 from Avid.
   https://www.avid.com/resource-center/pro-tools-scripting-sdk
3. Copy Source/PTSL.proto from the extracted SDK to this path. Create the folders if needed.
   ~/Library/Application Support/AutoEdit V0.3.9/Runner/SDK/PTSL.proto
4. Open Pro Tools and a copy of the Session you want to edit, then start AutoEdit.

1. 将 AutoEdit V0.3.9 拖入“应用程序”。需要 macOS 14 或更新版本。
2. 按照上方链接的说明，从 Avid 获取 Pro Tools Scripting SDK 2025.10。
3. 将解压后 Source 目录中的 PTSL.proto 复制到下方路径。若文件夹不存在，请先创建。
   ~/Library/Application Support/AutoEdit V0.3.9/Runner/SDK/PTSL.proto
4. 启动 Pro Tools，打开要处理的工程副本，然后打开 AutoEdit。

Node.js is bundled. This prerelease has an ad-hoc signature and is not notarized.
If macOS blocks the first launch, open System Settings → Privacy & Security
and choose Open Anyway for AutoEdit.

安装包内置 Node.js。此预发行版使用临时签名，未经 Apple 公证。
如果 macOS 阻止首次启动，请在“系统设置 → 隐私与安全性”中为 AutoEdit 选择“仍要打开”。
INSTRUCTIONS

echo "Creating DMG..."
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING_DIR" \
  -ov -format UDZO "$DMG_PATH" >/dev/null

echo "Built $DMG_PATH"
