#!/usr/bin/env bash
set -euo pipefail

APP_NAME="AutoEdit V0.3.9"
EXECUTABLE_NAME="AutoEdit"
VERSION="0.3.9"
NODE_VERSION="v24.19.0"

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$APP_ROOT/.." && pwd)"
RUNNER_SOURCE="$WORKSPACE_ROOT/tools/ptsl-runner"
PROTO_SOURCE="$WORKSPACE_ROOT/third_party/PTSL_SDK_CPP.2025.10.0.1267955/Source/PTSL.proto"
DIST_DIR="$APP_ROOT/dist"
APP_DIR="$DIST_DIR/$APP_NAME.app"
RUNNER_BUNDLE="$APP_DIR/Contents/Resources/ptsl-runner"
STAGING_DIR="$DIST_DIR/dmg-root"
CACHE_DIR="$DIST_DIR/cache"
ICONSET_DIR="$DIST_DIR/AutoEdit.iconset"
ICON_FILE="$DIST_DIR/AutoEdit.icns"
DMG_PATH="$DIST_DIR/AutoEdit-$VERSION-universal-unsigned.dmg"

for command in swift curl tar lipo hdiutil sips iconutil npm node; do
  command -v "$command" >/dev/null || {
    echo "Missing build dependency: $command" >&2
    exit 1
  }
done

[[ -f "$PROTO_SOURCE" ]] || {
  echo "Missing PTSL.proto at $PROTO_SOURCE" >&2
  exit 1
}

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
protocol_generator="$RUNNER_BUNDLE/generateRuntimeProtocol.mjs"
cp "$RUNNER_SOURCE/scripts/generateRuntimeProtocol.mjs" "$protocol_generator"
node "$protocol_generator" "$PROTO_SOURCE" "$RUNNER_BUNDLE"
rm "$protocol_generator"

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
cat > "$STAGING_DIR/安装说明.txt" <<'INSTRUCTIONS'
AutoEdit V0.3.9 内部测试候选版

1. 将 AutoEdit V0.3.9 拖入 Applications。
2. 第一次启动时，请在 Finder 中右键 AutoEdit V0.3.9，选择“打开”，再确认打开。
3. 如果 macOS 仍阻止运行，请到“系统设置 > 隐私与安全性”中选择“仍要打开”。
4. 启动支持 PTSL 的 Pro Tools，并打开需要处理的 Session。

可与旧版 AutoEdit 共存；设置、缓存和日志独立。录音配置库共享，修改或删除配置会影响两版可见的同一份配置。
请勿让两个版本同时向同一个 Pro Tools 工程执行。

本版本未使用 Apple Developer ID 签名，也未经过 Apple 公证。
AutoEdit 已内置运行所需的 Node.js 和 PTSL runner，不需要安装 CMake、Node.js 或 PTSL SDK。

本候选修复录音参考轨含淡入或 Crossfade 时的源样本偏移。
已通过离线回归；尚未进行真实 Pro Tools 导入和听音验收。
INSTRUCTIONS

echo "Creating DMG..."
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING_DIR" \
  -ov -format UDZO "$DMG_PATH" >/dev/null

echo "Built $DMG_PATH"
