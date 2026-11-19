# AutoEdit

AutoEdit is a macOS app for conforming multitrack recordings to an edited reference in Pro Tools. It maps edits from an Edit Session back to the original takes in a Recording Session and places the matching audio on new destination tracks. It supports reusable Recording Profiles, mono and stereo tracks, fades, and clip mute.

AutoEdit 是一款 macOS 应用，用于将 Pro Tools 中的原始多轨录音对齐到剪辑参考轨。它把剪辑工程中的编辑映射回录音工程中的原始素材，并写入新的目标轨道。支持可复用的录音配置、单声道与立体声轨道、淡入淡出、交叉淡化和片段静音。

## v0.3.9 test candidate

This version corrects source-sample alignment when the Recording Reference contains standalone fades or asymmetric crossfades. This candidate has been tested offline. Live imports and listening checks in Pro Tools are still pending. Use a copy of your Session for testing.

此版本修正录音参考轨含独立淡变或非对称交叉淡化时的源样本对齐。候选版已通过离线测试，仍需在实际 Pro Tools 工程中验证导入与听音。请用工程副本试用。

## Build and test / 构建与测试

Use macOS 14 or later with Swift 6, macOS developer tools, and Node.js 24 with npm. Pro Tools integration requires a local Pro Tools installation compatible with the 2025.10 PTSL protocol and the 2025.10 Pro Tools Scripting SDK. Follow [Avid's SDK access instructions](https://www.avid.com/resource-center/pro-tools-scripting-sdk). Extract the SDK locally so the protocol file is at `third_party/PTSL_SDK_CPP.2025.10.0.1267955/Source/PTSL.proto`.

需要 macOS 14 或更新版本、Swift 6、macOS 开发工具及带 npm 的 Node.js 24。与 Pro Tools 联动时，请使用兼容 PTSL 2025.10 的 Pro Tools，按照 [Avid 的 SDK 获取说明](https://www.avid.com/resource-center/pro-tools-scripting-sdk) 下载对应版本，将协议文件放到上面的路径。离线测试无需安装 Pro Tools 或 SDK。

From the repository root / 在仓库根目录运行

```sh
npm --prefix tools/ptsl-runner ci
npm --prefix tools/ptsl-runner test
swift test --package-path 'AutoEdit App'
"AutoEdit App/Scripts/build_app.sh"
```

Open `AutoEdit App/build/AutoEdit V0.3.9.app` to use the workspace runner. After installing the SDK, run `"AutoEdit App/Scripts/build_dmg.sh" --app-only` to build a universal app locally under `AutoEdit App/dist/` with Node.js and the runner bundled.

打开 `AutoEdit App/build/AutoEdit V0.3.9.app` 即可使用工作区中的运行器。安装 SDK 后，可执行 `"AutoEdit App/Scripts/build_dmg.sh" --app-only`，在本地 `AutoEdit App/dist/` 构建内置 Node.js 和运行器的通用版应用。

## Workflow / 使用流程

1. Open the Recording Session in Pro Tools and select **Export Recording Session** in AutoEdit. Configure the Recording Reference and target tracks for each Recording Group, then save the profile.
2. Open the Edit Session, load the saved profile, and select **Export Edit Session**. Choose the Edited Demo Track for each enabled group.
3. Confirm the destination Session and track names, choose an audio import mode, and click **Apply**. Review any position warnings before proceeding.

1. 在 Pro Tools 打开录音工程，在 AutoEdit 导出录音工程。为每个录音组选择参考轨和要对齐的录音轨，再保存配置。
2. 打开剪辑工程，加载已保存的配置并导出剪辑工程。为每个启用的录音组选择对应的剪辑参考轨。
3. 核对目标工程和轨道名称，选择音频导入方式后点击 **执行**。如出现位置警告，先检查受影响的轨道和样本范围。

## License / 许可证

AutoEdit's own source is released under the [MIT License](LICENSE). The Avid Pro Tools Scripting SDK is obtained separately from Avid and governed by its own license.

AutoEdit 自有源码采用 [MIT 许可证](LICENSE)。Avid Pro Tools Scripting SDK 由 Avid 单独提供，适用其自身许可条款。
