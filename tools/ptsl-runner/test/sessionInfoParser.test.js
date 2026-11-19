import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { parseSessionInfoText, audioEventsForTrack } from "../src/sessionInfoParser.js";

const fixture = fs.readFileSync(new URL("./fixtures/session_info_minimal.txt", import.meta.url), "utf8");

test("parses session info metadata, clip sources, tracks, and markers", () => {
  const parsed = parseSessionInfoText(fixture);

  assert.equal(parsed.metadata.sessionName, "Fixture Session");
  assert.equal(parsed.metadata.sampleRate, 48000);
  assert.equal(parsed.onlineFiles.length, 3);
  assert.equal(parsed.onlineClips.length, 4);
  assert.equal(parsed.tracks.length, 2);
  assert.equal(parsed.markers.length, 1);

  const demoEvents = audioEventsForTrack(parsed, "DEMO_STEM");
  assert.equal(demoEvents.length, 2);
  assert.equal(demoEvents[0].clipName, "DEMO_01");
  assert.equal(demoEvents[0].sourceFile, "demo.wav");
  assert.equal(demoEvents[0].sourceChannel, 1);
  assert.equal(demoEvents[0].sourceStartSamples, 0);
  assert.equal(demoEvents[0].sourceEndSamples, 1000);
});

test("parses hidden and inactive track state", () => {
  const parsed = parseSessionInfoText(fixture.replace("STATE: \nCHANNEL", "STATE: Hidden Inactive \nCHANNEL"));
  const track = parsed.tracks.find((item) => item.name === "DEMO_STEM");

  assert.equal(track.isHidden, true);
  assert.equal(track.isInactive, true);
  assert.equal(track.events[0].isOnInactiveTrack, true);
});

test("allows duplicate online clip names when source file and channel are identical", () => {
  const withDuplicateClip = fixture.replace(
    "takeA-01                             \ttakeA.wav\t[1]\n",
    "takeA-01                             \ttakeA.wav\t[1]\n" +
    "takeA-01                             \ttakeA.wav\t[1]\n"
  );
  const parsed = parseSessionInfoText(withDuplicateClip);
  const event = audioEventsForTrack(parsed, "REC_VLN")[0];

  assert.equal(event.clipName, "takeA-01");
  assert.equal(event.sourceFile, "takeA.wav");
  assert.equal(event.sourceChannel, 1);
  assert.deepEqual(parsed.warnings, []);
});

test("parses Simplified Chinese Pro Tools Session Info", () => {
  const chineseFixture = `工程名：\t中文测试工程
采样率：\t48000.000000
比特精度：\t24－比特
音频轨道数：\t1
音频片段数：\t2
音频文件数：\t1

工 程 中 在 线 的 文 件
文件名\t位置
demo.wav\tMacintosh HD:Audio Files:

工 程 中 的 在 线 片 段
片段名称\t源文件
demo-01.L\tdemo.wav\t[1]

轨 道 列 表
轨道名：\tEDIT_DEMO (立体声)
注释：\t测试
用户延时:\t0 采样
状态： 隐藏 未激活
通道\t事件\t片段名称\t开始时间\t结束时间\t长度\t时间标记\t状态
1\t1\t(淡入)\t900\t1000\t100\t0\t未静音
1\t2\tdemo-01.L\t1000\t2000\t1000\t4000\t静音
1\t3\t(交叠淡变)\t2000\t2100\t100\t0\t未静音
1\t4\t(淡出)\t2100\t2200\t100\t0\t未静音

标 记 点 列 表
#\t位置\t时间参考\t单元\t名字\t轨道名称\t轨道类型\t注释
1\t1000\t1000\t采样\t标记 1\t标记点\t标尺\t
`;

  const parsed = parseSessionInfoText(chineseFixture);
  const parsedTrack = parsed.tracks[0];

  assert.equal(parsed.metadata.sessionName, "中文测试工程");
  assert.equal(parsed.metadata.sampleRate, 48000);
  assert.equal(parsed.metadata.audioTrackCount, 1);
  assert.equal(parsed.onlineFiles.length, 1);
  assert.equal(parsed.onlineClips.length, 1);
  assert.equal(parsed.tracks.length, 1);
  assert.equal(parsed.markers.length, 1);
  assert.equal(parsedTrack.name, "EDIT_DEMO");
  assert.equal(parsedTrack.isHidden, true);
  assert.equal(parsedTrack.isInactive, true);
  assert.deepEqual(parsedTrack.events.map((event) => event.type), [
    "fade-in",
    "audio",
    "crossfade",
    "fade-out"
  ]);
  assert.equal(parsedTrack.events[1].isMuted, true);
  assert.equal(parsedTrack.events[1].sourceFile, "demo.wav");
  assert.equal(parsedTrack.events[1].sourceChannel, 1);
  assert.deepEqual(parsed.warnings, []);
});

test("warns when a declared track listing cannot be parsed", () => {
  const parsed = parseSessionInfoText("音频轨道数：\t3\n未知轨道格式\n");

  assert.equal(parsed.tracks.length, 0);
  assert.match(parsed.warnings[0], /declares 3 audio track/);
});
