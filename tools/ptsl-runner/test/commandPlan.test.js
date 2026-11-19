import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCommandPlan } from "../src/commandPlan.js";

test("groups stereo channel conform entries into one multichannel clip command", () => {
  const plan = buildCommandPlan({
    project: "Fixture",
    sampleRate: 48000,
    clips: [
      {
        cueId: "CUE01",
        destinationTrack: "REAL_ST",
        sourceFile: "take.wav",
        sourceFilePath: "/tmp/take.wav",
        sourceFileOnline: true,
        sourceClipOnline: true,
        sourceClipName: "take.L",
        channel: 1,
        sourceChannel: 1,
        sourceStartSamples: 100,
        sourceEndSamples: 200,
        timelineStartSamples: 1000,
        timelineEndSamples: 1100
      },
      {
        cueId: "CUE01",
        destinationTrack: "REAL_ST",
        sourceFile: "take.wav",
        sourceFilePath: "/tmp/take.wav",
        sourceFileOnline: true,
        sourceClipOnline: true,
        sourceClipName: "take.R",
        channel: 2,
        sourceChannel: 2,
        sourceStartSamples: 100,
        sourceEndSamples: 200,
        timelineStartSamples: 1000,
        timelineEndSamples: 1100
      }
    ]
  });

  assert.equal(plan.summary.imports, 1);
  assert.equal(plan.summary.createTracks, 1);
  assert.equal(plan.summary.clipGroups, 1);
  assert.equal(plan.createTracks[0].track_format, "TFormat_Stereo");
  assert.equal(plan.clipGroups[0].createAudioClipRequest.clip_list[0].channel_format, "SFormat_Stereo");
  assert.equal(plan.clipGroups[0].createAudioClipRequest.clip_list[0].clip_info.length, 2);
  assert.equal(
    plan.clipGroups[0].createAudioClipRequest.clip_list[0].clip_info[0].src_channel.name,
    "SChannel_Left"
  );
  assert.equal(
    plan.clipGroups[0].createAudioClipRequest.clip_list[0].clip_info[1].src_channel.name,
    "SChannel_Right"
  );
});

test("warns when command plan uses offline sources", () => {
  const plan = buildCommandPlan({
    project: "Fixture",
    sampleRate: 48000,
    clips: [
      {
        cueId: "CUE01",
        sourceTrack: "REC_OFFLINE",
        destinationTrack: "REAL_MONO",
        sourceFile: "missing.wav",
        sourceFilePath: "/tmp/missing.wav",
        sourceFileOnline: false,
        sourceClipOnline: false,
        sourceClipName: "missing",
        sourceTrackInactive: true,
        channel: 1,
        sourceChannel: 1,
        sourceStartSamples: 0,
        sourceEndSamples: 100,
        timelineStartSamples: 0,
        timelineEndSamples: 100
      }
    ]
  });

  assert.equal(plan.summary.warnings, 1);
  assert.equal(plan.summary.fatalIssues, 2);
  assert.match(plan.fatalIssues.join("\n"), /Source file is offline/);
  assert.match(plan.fatalIssues.join("\n"), /Source clip is offline/);
  assert.match(plan.warnings.join("\n"), /Source track is inactive/);
});

test("blocks an empty conform result when target tracks were selected", () => {
  const plan = buildCommandPlan({
    project: "Empty",
    sampleRate: 48000,
    summary: { requestedTargetTracks: 12 },
    clips: [],
    transitions: []
  });

  assert.equal(plan.summary.fatalIssues, 1);
  assert.match(plan.fatalIssues[0], /no clips for 12 selected target track/);
});

test("explains when selected recorded tracks do not overlap edited demo ranges", () => {
  const plan = buildCommandPlan({
    project: "No overlap",
    sampleRate: 48000,
    summary: { requestedTargetTracks: 6 },
    clips: [],
    gaps: [{ durationSamples: 48000 }],
    transitions: []
  });

  assert.equal(plan.summary.fatalIssues, 1);
  assert.match(plan.fatalIssues[0], /contain no audio overlapping the Edited Demo ranges/);
});

test("groups stereo transition entries into one fade command", () => {
  const plan = buildCommandPlan({
    project: "Fixture",
    sampleRate: 48000,
    clips: [],
    transitions: [
      {
        cueId: "CUE01",
        type: "crossfade",
        destinationTrack: "REAL_ST",
        sourceTrack: "REC_ST",
        channel: 1,
        timelineStartSamples: 1000,
        timelineEndSamples: 1200,
        timelineEditBoundarySamples: 1100,
        recordingStartSamples: 2000,
        recordingEndSamples: 2200,
        recordingEditBoundarySamples: 2100,
        leftClipName: "takeA.L",
        rightClipName: "takeB.L",
        fadePresetName: "AutoEdit Equal Power"
      },
      {
        cueId: "CUE01",
        type: "crossfade",
        destinationTrack: "REAL_ST",
        sourceTrack: "REC_ST",
        channel: 2,
        timelineStartSamples: 1000,
        timelineEndSamples: 1200,
        timelineEditBoundarySamples: 1100,
        recordingStartSamples: 2000,
        recordingEndSamples: 2200,
        recordingEditBoundarySamples: 2100,
        leftClipName: "takeA.R",
        rightClipName: "takeB.R",
        fadePresetName: "AutoEdit Equal Power"
      }
    ]
  });

  assert.equal(plan.summary.fadeGroups, 1);
  assert.equal(plan.summary.transitionEntries, 2);
  assert.deepEqual(plan.fadeGroups[0].channels.map((channel) => channel.channel), [1, 2]);
  assert.deepEqual(plan.fadeGroups[0].selectTracksByNameRequest.track_names, ["REAL_ST"]);
  assert.deepEqual(
    plan.fadeGroups[0].setTimelineSelectionRequest,
    {
      in_time: "1000",
      out_time: "1200",
      location_type: "TLType_Samples"
    }
  );
  assert.deepEqual(
    plan.fadeGroups[0].createFadesBasedOnPresetRequest,
    {
      fade_preset_name: "AutoEdit Equal Power",
      auto_adjust_bounds: true
    }
  );
});
