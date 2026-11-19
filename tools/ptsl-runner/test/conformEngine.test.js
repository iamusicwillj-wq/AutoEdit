import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { materializeSpotRequest, preflightCommandPlan } from "../src/applyEngine.js";
import { buildCommandPlan } from "../src/commandPlan.js";
import { conformManifest } from "../src/conformEngine.js";
import { parseSessionInfoText } from "../src/sessionInfoParser.js";
import { partialPreflight } from "../src/partialPlan.js";

const fixture = fs.readFileSync(new URL("./fixtures/session_info_minimal.txt", import.meta.url), "utf8");

test("projects demo edit ranges onto recording track and reports uncovered gaps", () => {
  const session = parseSessionInfoText(fixture);
  const plan = conformManifest({
    demoSession: session,
    recordingSession: session,
    manifest: {
      project: "Fixture",
      sample_rate: 48000,
      cues: [
        {
          cue_id: "CUE01",
          demo_track: "DEMO_STEM",
          demo_anchor_samples: 0,
          recording_anchor_samples: 500,
          target_tracks: [
            {
              source_track: "REC_VLN",
              destination_track: "REAL_VLN"
            }
          ]
        }
      ]
    }
  });

  assert.equal(plan.clips.length, 2);
  assert.equal(plan.gaps.length, 1);

  assert.deepEqual(
    {
      sourceFile: plan.clips[0].sourceFile,
      sourceStartSamples: plan.clips[0].sourceStartSamples,
      sourceEndSamples: plan.clips[0].sourceEndSamples,
      timelineStartSamples: plan.clips[0].timelineStartSamples,
      timelineEndSamples: plan.clips[0].timelineEndSamples
    },
    {
      sourceFile: "takeA.wav",
      sourceStartSamples: 10000,
      sourceEndSamples: 11000,
      timelineStartSamples: 1000,
      timelineEndSamples: 2000
    }
  );

  assert.deepEqual(
    {
      sourceFile: plan.clips[1].sourceFile,
      sourceStartSamples: plan.clips[1].sourceStartSamples,
      sourceEndSamples: plan.clips[1].sourceEndSamples,
      timelineStartSamples: plan.clips[1].timelineStartSamples,
      timelineEndSamples: plan.clips[1].timelineEndSamples
    },
    {
      sourceFile: "takeB.wav",
      sourceStartSamples: 20700,
      sourceEndSamples: 22400,
      timelineStartSamples: 3000,
      timelineEndSamples: 4700
    }
  );

  assert.deepEqual(
    {
      recordingStartSamples: plan.gaps[0].recordingStartSamples,
      recordingEndSamples: plan.gaps[0].recordingEndSamples,
      timelineStartSamples: plan.gaps[0].timelineStartSamples,
      timelineEndSamples: plan.gaps[0].timelineEndSamples
    },
    {
      recordingStartSamples: 4200,
      recordingEndSamples: 4500,
      timelineStartSamples: 4700,
      timelineEndSamples: 5000
    }
  );
});

test("accepts two-session manifest field names", () => {
  const session = parseSessionInfoText(fixture);
  const plan = conformManifest({
    demoSession: session,
    recordingSession: session,
    manifest: {
      project: "Two Session Naming",
      sample_rate: 48000,
      cues: [
        {
          cue_id: "CUE01",
          edit_demo_track: "DEMO_STEM",
          edit_demo_anchor_samples: 0,
          recording_anchor_samples: 500,
          target_tracks: [
            {
              recording_source_track: "REC_VLN",
              edit_destination_track: "REAL_VLN"
            }
          ]
        }
      ]
    }
  });

  assert.equal(plan.clips.length, 2);
  assert.equal(plan.clips[0].destinationTrack, "REAL_VLN");
  assert.equal(plan.clips[0].sourceTrack, "REC_VLN");
  assert.equal(plan.clips[0].demoTrack, "DEMO_STEM");
});

function sessionFromTracks(tracks) {
  return {
    metadata: { sampleRate: 48000 },
    tracks,
    warnings: []
  };
}

function track(name, events) {
  return {
    name,
    rawName: name,
    isHidden: false,
    isInactive: false,
    events
  };
}

function event({
  trackName,
  channel,
  clipName,
  timelineStartSamples,
  timelineEndSamples,
  sourceStartSamples,
  sourceEndSamples = null,
  clipListSourceStartSamples = null,
  clipListSourceEndSamples = null,
  sourceFile = `${clipName}.wav`,
  sourceFilePath = `/tmp/${sourceFile}`,
  sourceChannel = channel,
  type = "audio",
  isMuted = false
}) {
  return {
    trackName,
    trackRawName: trackName,
    channel,
    clipName,
    timelineStartSamples,
    timelineEndSamples,
    durationSamples: timelineEndSamples - timelineStartSamples,
    sourceStartSamples: type === "audio" ? sourceStartSamples : null,
    sourceEndSamples: type === "audio"
      ? (sourceEndSamples ?? sourceStartSamples + (timelineEndSamples - timelineStartSamples))
      : null,
    sourceFile,
    sourceFilePath,
    sourceChannel: type === "audio" ? sourceChannel : null,
    clipListSourceStartSamples,
    clipListSourceEndSamples,
    sourceRangeBasis: "get_clip_list_start_plus_timeline_duration",
    type,
    isFade: type !== "audio",
    isMuted,
    isOnInactiveTrack: false,
    isOnHiddenTrack: false
  };
}

function crossfadeEvent(trackName, channel, start, end) {
  return event({
    trackName,
    channel,
    clipName: "(cross fade)",
    timelineStartSamples: start,
    timelineEndSamples: end,
    sourceStartSamples: null,
    sourceFile: "",
    sourceChannel: null,
    type: "crossfade"
  });
}

function fadeEvent(trackName, channel, type, start, end) {
  return event({
    trackName,
    channel,
    clipName: type === "fade-in" ? "(fade in)" : "(fade out)",
    timelineStartSamples: start,
    timelineEndSamples: end,
    sourceStartSamples: null,
    sourceFile: "",
    sourceChannel: null,
    type
  });
}

function editEvent(id, sourceStartSamples, sourceEndSamples, timelineStartSamples) {
  const durationSamples = sourceEndSamples - sourceStartSamples;
  return event({
    trackName: "EDIT_DEMO_ST",
    channel: 1,
    clipName: `EDIT_DEMO_ST_${id}.L`,
    timelineStartSamples,
    timelineEndSamples: timelineStartSamples + durationSamples,
    sourceStartSamples,
    sourceFile: "edit_demo_st.wav"
  });
}

function recordingTakeEvents(trackName, { stereo = false } = {}) {
  const channels = stereo ? [1, 2] : [1];
  return channels.flatMap((channel) => [
    event({
      trackName,
      channel,
      clipName: `${trackName}_TAKE_A${stereo ? (channel === 1 ? ".L" : ".R") : ""}`,
      timelineStartSamples: 96000,
      timelineEndSamples: 288000,
      sourceStartSamples: 48000,
      sourceFile: `${trackName.toLowerCase()}_take_a.wav`
    }),
    event({
      trackName,
      channel,
      clipName: `${trackName}_TAKE_B${stereo ? (channel === 1 ? ".L" : ".R") : ""}`,
      timelineStartSamples: 312000,
      timelineEndSamples: 480000,
      sourceStartSamples: 96000,
      sourceFile: `${trackName.toLowerCase()}_take_b.wav`
    })
  ]);
}

test("maps edited demo source ranges through the recording reference without anchors", () => {
  const demoSession = sessionFromTracks([
    track("EDIT_DEMO_ST", [
      event({
        trackName: "EDIT_DEMO_ST",
        channel: 1,
        clipName: "EDIT_CUT_A",
        timelineStartSamples: 1000000,
        timelineEndSamples: 1001000,
        sourceStartSamples: 2000,
        sourceFile: "demo_edit_copy.wav"
      }),
      event({
        trackName: "EDIT_DEMO_ST",
        channel: 1,
        clipName: "EDIT_CUT_A_REPEAT",
        timelineStartSamples: 1100000,
        timelineEndSamples: 1101000,
        sourceStartSamples: 2000,
        sourceFile: "demo_edit_copy.wav"
      }),
      event({
        trackName: "EDIT_DEMO_ST",
        channel: 1,
        clipName: "EDIT_CUT_B",
        timelineStartSamples: 1200000,
        timelineEndSamples: 1201000,
        sourceStartSamples: 5000,
        sourceFile: "demo_edit_copy.wav"
      })
    ])
  ]);
  const recordingSession = sessionFromTracks([
    track("REC_REF_ST", [
      event({
        trackName: "REC_REF_ST",
        channel: 1,
        clipName: "REC_REFERENCE_FULL",
        timelineStartSamples: 50000,
        timelineEndSamples: 60000,
        sourceStartSamples: 0,
        sourceFile: "demo_recording_copy.wav"
      })
    ]),
    track("REC_MAIN", [
      event({
        trackName: "REC_MAIN",
        channel: 1,
        clipName: "REC_TAKE",
        timelineStartSamples: 50000,
        timelineEndSamples: 60000,
        sourceStartSamples: 7000,
        sourceFile: "recorded_take.wav"
      })
    ])
  ]);

  const plan = conformManifest({
    demoSession,
    recordingSession,
    manifest: {
      project: "Reference Mapping",
      sample_rate: 48000,
      cues: [{
        cue_id: "REF01",
        recording_reference_track: "REC_REF_ST",
        edit_demo_track: "EDIT_DEMO_ST",
        target_tracks: [{
          recording_source_track: "REC_MAIN",
          edit_destination_track: "CONF_MAIN"
        }]
      }]
    }
  });

  assert.equal(plan.cues[0].mappingMode, "demo_source_via_recording_reference");
  assert.equal(plan.clips.length, 3);
  assert.equal(plan.gaps.length, 0);
  assert.equal(plan.warnings.length, 0);
  assert.deepEqual(plan.clips.map((clip) => ({
    sourceStartSamples: clip.sourceStartSamples,
    timelineStartSamples: clip.timelineStartSamples
  })), [
    { sourceStartSamples: 9000, timelineStartSamples: 1000000 },
    { sourceStartSamples: 9000, timelineStartSamples: 1100000 },
    { sourceStartSamples: 12000, timelineStartSamples: 1200000 }
  ]);
});

test("warns when edited demo source range is outside the recording reference", () => {
  const demoSession = sessionFromTracks([
    track("EDIT_DEMO_ST", [editEvent("OUTSIDE", 12000, 13000, 1000000)])
  ]);
  const recordingSession = sessionFromTracks([
    track("REC_REF_ST", [event({
      trackName: "REC_REF_ST",
      channel: 1,
      clipName: "REC_REFERENCE_FULL",
      timelineStartSamples: 50000,
      timelineEndSamples: 60000,
      sourceStartSamples: 0,
      sourceFile: "edit_demo_st.wav"
    })]),
    track("REC_MAIN", [event({
      trackName: "REC_MAIN",
      channel: 1,
      clipName: "REC_TAKE",
      timelineStartSamples: 50000,
      timelineEndSamples: 60000,
      sourceStartSamples: 0,
      sourceFile: "recorded_take.wav"
    })])
  ]);

  const plan = conformManifest({
    demoSession,
    recordingSession,
    manifest: {
      cues: [{
        cue_id: "REF_OUTSIDE",
        recording_reference_track: "REC_REF_ST",
        edit_demo_track: "EDIT_DEMO_ST",
        target_tracks: [{ recording_source_track: "REC_MAIN" }]
      }]
    }
  });

  assert.equal(plan.clips.length, 0);
  assert.match(plan.warnings[0], /not covered by recording reference/);
});

test("maps one edited demo clip across split recording reference clips", () => {
  const demoSession = sessionFromTracks([
    track("EDIT_DEMO_ST", [editEvent("ACROSS_SPLIT", 250, 750, 1000000)])
  ]);
  const recordingSession = sessionFromTracks([
    track("REC_REF_ST", [
      event({
        trackName: "REC_REF_ST",
        channel: 1,
        clipName: "REF_A",
        timelineStartSamples: 5000,
        timelineEndSamples: 5500,
        sourceStartSamples: 0,
        sourceFile: "edit_demo_st.wav"
      }),
      event({
        trackName: "REC_REF_ST",
        channel: 1,
        clipName: "REF_B",
        timelineStartSamples: 7000,
        timelineEndSamples: 7500,
        sourceStartSamples: 500,
        sourceFile: "edit_demo_st.wav"
      })
    ]),
    track("REC_MAIN", [
      event({
        trackName: "REC_MAIN",
        channel: 1,
        clipName: "TAKE_A",
        timelineStartSamples: 5000,
        timelineEndSamples: 5500,
        sourceStartSamples: 10000
      }),
      event({
        trackName: "REC_MAIN",
        channel: 1,
        clipName: "TAKE_B",
        timelineStartSamples: 7000,
        timelineEndSamples: 7500,
        sourceStartSamples: 20000
      })
    ])
  ]);

  const plan = conformManifest({
    demoSession,
    recordingSession,
    manifest: {
      cues: [{
        cue_id: "REF_SPLIT",
        recording_reference_track: "REC_REF_ST",
        edit_demo_track: "EDIT_DEMO_ST",
        target_tracks: [{ recording_source_track: "REC_MAIN" }]
      }]
    }
  });

  assert.equal(plan.warnings.length, 0);
  assert.equal(plan.clips.length, 2);
  assert.deepEqual(plan.clips.map((clip) => ({
    sourceStartSamples: clip.sourceStartSamples,
    timelineStartSamples: clip.timelineStartSamples,
    timelineEndSamples: clip.timelineEndSamples
  })), [
    { sourceStartSamples: 10250, timelineStartSamples: 1000000, timelineEndSamples: 1000250 },
    { sourceStartSamples: 20000, timelineStartSamples: 1000250, timelineEndSamples: 1000500 }
  ]);
});

test("rejects filename fallback when recording reference contains multiple sources", () => {
  const demoSession = sessionFromTracks([
    track("EDIT_DEMO_ST", [event({
      trackName: "EDIT_DEMO_ST",
      channel: 1,
      clipName: "EDIT_UNKNOWN_SOURCE",
      timelineStartSamples: 1000000,
      timelineEndSamples: 1000500,
      sourceStartSamples: 0,
      sourceFile: "unmatched_demo_copy.wav"
    })])
  ]);
  const recordingSession = sessionFromTracks([
    track("REC_REF_ST", [
      event({
        trackName: "REC_REF_ST",
        channel: 1,
        clipName: "REF_SOURCE_A",
        timelineStartSamples: 5000,
        timelineEndSamples: 5500,
        sourceStartSamples: 0,
        sourceFile: "source_a.wav"
      }),
      event({
        trackName: "REC_REF_ST",
        channel: 1,
        clipName: "REF_SOURCE_B",
        timelineStartSamples: 7000,
        timelineEndSamples: 7500,
        sourceStartSamples: 0,
        sourceFile: "source_b.wav"
      })
    ]),
    track("REC_MAIN", [event({
      trackName: "REC_MAIN",
      channel: 1,
      clipName: "REC_TAKE",
      timelineStartSamples: 5000,
      timelineEndSamples: 7500,
      sourceStartSamples: 0
    })])
  ]);

  const plan = conformManifest({
    demoSession,
    recordingSession,
    manifest: {
      cues: [{
        cue_id: "REF_AMBIGUOUS",
        recording_reference_track: "REC_REF_ST",
        edit_demo_track: "EDIT_DEMO_ST",
        target_tracks: [{ recording_source_track: "REC_MAIN" }]
      }]
    }
  });

  assert.equal(plan.clips.length, 0);
  assert.match(plan.warnings[0], /not covered by recording reference/);
});

test("does not conform without a recording reference or legacy anchors", () => {
  const demoSession = sessionFromTracks([
    track("EDIT_DEMO_ST", [editEvent("NO_MAPPING", 0, 500, 1000000)])
  ]);
  const recordingSession = sessionFromTracks([
    track("REC_MAIN", [event({
      trackName: "REC_MAIN",
      channel: 1,
      clipName: "REC_TAKE",
      timelineStartSamples: 0,
      timelineEndSamples: 500,
      sourceStartSamples: 0
    })])
  ]);

  const plan = conformManifest({
    demoSession,
    recordingSession,
    manifest: {
      cues: [{
        cue_id: "NO_MAPPING",
        edit_demo_track: "EDIT_DEMO_ST",
        target_tracks: [{ recording_source_track: "REC_MAIN" }]
      }]
    }
  });

  assert.equal(plan.clips.length, 0);
  assert.equal(plan.cues[0].mappingMode, "missing");
  assert.match(plan.warnings[0], /missing recording_reference_track/);
});

test("projects one edit demo track onto a mixed stereo and mono mic group", () => {
  const demoSession = sessionFromTracks([
    track("EDIT_DEMO_ST", [
      editEvent("CUT_01", 96000, 192000, 960000),
      editEvent("CUT_02_CROSSES_REC_GAP", 192000, 300000, 1056000),
      editEvent("CUT_03", 312000, 384000, 1164000),
      editEvent("CUT_04", 384000, 456000, 1236000)
    ])
  ]);
  const recordingSession = sessionFromTracks([
    track("REC_MAIN_ST", recordingTakeEvents("REC_MAIN_ST", { stereo: true })),
    track("REC_SPOT_VLN1_M1", recordingTakeEvents("REC_SPOT_VLN1_M1")),
    track("REC_SPOT_VLN1_M2", recordingTakeEvents("REC_SPOT_VLN1_M2")),
    track("REC_ROOM_ST", recordingTakeEvents("REC_ROOM_ST", { stereo: true }))
  ]);

  const plan = conformManifest({
    demoSession,
    recordingSession,
    manifest: {
      project: "Mic Group",
      sample_rate: 48000,
      cues: [
        {
          cue_id: "AUTOEDIT_SCENARIO",
          edit_demo_track: "EDIT_DEMO_ST",
          edit_demo_anchor_samples: 0,
          recording_anchor_samples: 0,
          target_tracks: [
            { recording_source_track: "REC_MAIN_ST", edit_destination_track: "CONF_MAIN_ST" },
            { recording_source_track: "REC_SPOT_VLN1_M1", edit_destination_track: "CONF_SPOT_VLN1_M1" },
            { recording_source_track: "REC_SPOT_VLN1_M2", edit_destination_track: "CONF_SPOT_VLN1_M2" },
            { recording_source_track: "REC_ROOM_ST", edit_destination_track: "CONF_ROOM_ST" }
          ]
        }
      ]
    }
  });

  assert.equal(plan.clips.length, 24);
  assert.equal(plan.gaps.length, 4);
  assert.equal(plan.summary.outputClipEntries, 24);
  assert.equal(plan.summary.gaps, 4);

  const mainGap = plan.gaps.find((gap) => gap.destinationTrack === "CONF_MAIN_ST");
  assert.deepEqual(
    {
      recordingStartSamples: mainGap.recordingStartSamples,
      recordingEndSamples: mainGap.recordingEndSamples,
      timelineStartSamples: mainGap.timelineStartSamples,
      timelineEndSamples: mainGap.timelineEndSamples
    },
    {
      recordingStartSamples: 288000,
      recordingEndSamples: 300000,
      timelineStartSamples: 1152000,
      timelineEndSamples: 1164000
    }
  );

  const mainCut2Left = plan.clips.find((clip) =>
    clip.destinationTrack === "CONF_MAIN_ST" &&
    clip.demoClipName === "EDIT_DEMO_ST_CUT_02_CROSSES_REC_GAP.L" &&
    clip.channel === 1
  );
  assert.deepEqual(
    {
      sourceStartSamples: mainCut2Left.sourceStartSamples,
      sourceEndSamples: mainCut2Left.sourceEndSamples,
      timelineStartSamples: mainCut2Left.timelineStartSamples,
      timelineEndSamples: mainCut2Left.timelineEndSamples
    },
    {
      sourceStartSamples: 144000,
      sourceEndSamples: 240000,
      timelineStartSamples: 1056000,
      timelineEndSamples: 1152000
    }
  );
});

test("treats recording crossfades as transition coverage instead of gaps", () => {
  const demoSession = sessionFromTracks([
    track("EDIT_DEMO_ST", [
      editEvent("CUT_WITH_XF", 1000, 3200, 10000)
    ])
  ]);
  const recordingSession = sessionFromTracks([
    track("REC_VLN", [
      event({
        trackName: "REC_VLN",
        channel: 1,
        clipName: "REC_VLN_TAKE_A",
        timelineStartSamples: 1000,
        timelineEndSamples: 2000,
        sourceStartSamples: 100,
        sourceEndSamples: 1100,
        clipListSourceStartSamples: 100,
        clipListSourceEndSamples: 1200,
        sourceFile: "take_a.wav"
      }),
      crossfadeEvent("REC_VLN", 1, 2000, 2200),
      event({
        trackName: "REC_VLN",
        channel: 1,
        clipName: "REC_VLN_TAKE_B",
        timelineStartSamples: 2200,
        timelineEndSamples: 3200,
        sourceStartSamples: 500,
        sourceEndSamples: 1500,
        clipListSourceStartSamples: 500,
        clipListSourceEndSamples: 1600,
        sourceFile: "take_b.wav"
      })
    ])
  ]);

  const plan = conformManifest({
    demoSession,
    recordingSession,
    manifest: {
      project: "Crossfade",
      sample_rate: 48000,
      cues: [
        {
          cue_id: "XF01",
          edit_demo_track: "EDIT_DEMO_ST",
          edit_demo_anchor_samples: 0,
          recording_anchor_samples: 0,
          target_tracks: [
            {
              recording_source_track: "REC_VLN",
              edit_destination_track: "CONF_VLN"
            }
          ]
        }
      ]
    }
  });

  assert.equal(plan.gaps.length, 0);
  assert.equal(plan.transitions.length, 1);
  assert.equal(plan.summary.transitions, 1);
  assert.deepEqual(
    {
      recordingStartSamples: plan.transitions[0].recordingStartSamples,
      recordingEndSamples: plan.transitions[0].recordingEndSamples,
      recordingEditBoundarySamples: plan.transitions[0].recordingEditBoundarySamples,
      timelineStartSamples: plan.transitions[0].timelineStartSamples,
      timelineEndSamples: plan.transitions[0].timelineEndSamples,
      timelineEditBoundarySamples: plan.transitions[0].timelineEditBoundarySamples,
      leftClipName: plan.transitions[0].leftClipName,
      rightClipName: plan.transitions[0].rightClipName
    },
    {
      recordingStartSamples: 2000,
      recordingEndSamples: 2200,
      recordingEditBoundarySamples: 2100,
      timelineStartSamples: 11000,
      timelineEndSamples: 11200,
      timelineEditBoundarySamples: 11100,
      leftClipName: "REC_VLN_TAKE_A",
      rightClipName: "REC_VLN_TAKE_B"
    }
  );

  assert.deepEqual(
    plan.clips.map((clip) => ({
      sourceClipName: clip.sourceClipName,
      sourceStartSamples: clip.sourceStartSamples,
      sourceEndSamples: clip.sourceEndSamples,
      timelineStartSamples: clip.timelineStartSamples,
      timelineEndSamples: clip.timelineEndSamples,
      hiddenSourcePrefixSamples: clip.hiddenSourcePrefixSamples,
      hiddenSourceSuffixSamples: clip.hiddenSourceSuffixSamples
    })),
    [
      {
        sourceClipName: "REC_VLN_TAKE_A",
        sourceStartSamples: 100,
        sourceEndSamples: 1200,
        timelineStartSamples: 10000,
        timelineEndSamples: 11100,
        hiddenSourcePrefixSamples: 0,
        hiddenSourceSuffixSamples: 100
      },
      {
        sourceClipName: "REC_VLN_TAKE_B",
        sourceStartSamples: 500,
        sourceEndSamples: 1600,
        timelineStartSamples: 11100,
        timelineEndSamples: 12200,
        hiddenSourcePrefixSamples: 100,
        hiddenSourceSuffixSamples: 0
      }
    ]
  );
});

test("trims fade-in and fade-out handles without shifting visible audio", () => {
  const demoSession = sessionFromTracks([
    track("EDIT_DEMO_ST", [editEvent("FADED", 132896, 3886880, 1000000)])
  ]);
  const recordingSession = sessionFromTracks([
    track("REC_REF_ST", [event({
      trackName: "REC_REF_ST",
      channel: 1,
      clipName: "REC_REFERENCE_FULL",
      timelineStartSamples: 315616,
      timelineEndSamples: 4300270,
      sourceStartSamples: 0,
      sourceFile: "strings demo.wav"
    })]),
    track("REC_MAIN_ST", [
      fadeEvent("REC_MAIN_ST", 1, "fade-in", 399360, 448512),
      event({
        trackName: "REC_MAIN_ST",
        channel: 1,
        clipName: "STR1-OH_01-01.L",
        timelineStartSamples: 448512,
        timelineEndSamples: 4202496,
        sourceStartSamples: 83744,
        sourceEndSamples: 3837728,
        clipListSourceStartSamples: 83744,
        clipListSourceEndSamples: 3915552,
        sourceFile: "STR1-OH_01.wav"
      }),
      fadeEvent("REC_MAIN_ST", 1, "fade-out", 4202496, 4231168)
    ])
  ]);

  const plan = conformManifest({
    demoSession,
    recordingSession,
    manifest: {
      project: "Fade Handles",
      sample_rate: 48000,
      cues: [{
        cue_id: "FADE01",
        recording_reference_track: "REC_REF_ST",
        edit_demo_track: "EDIT_DEMO_ST",
        target_tracks: [{
          recording_source_track: "REC_MAIN_ST",
          edit_destination_track: "CONF_MAIN_ST"
        }]
      }]
    }
  });

  assert.equal(plan.gaps.length, 0);
  assert.equal(plan.clips.length, 1);
  assert.deepEqual(
    {
      sourceStartSamples: plan.clips[0].sourceStartSamples,
      sourceEndSamples: plan.clips[0].sourceEndSamples,
      timelineStartSamples: plan.clips[0].timelineStartSamples,
      timelineEndSamples: plan.clips[0].timelineEndSamples,
      hiddenSourcePrefixSamples: plan.clips[0].hiddenSourcePrefixSamples,
      hiddenSourceSuffixSamples: plan.clips[0].hiddenSourceSuffixSamples
    },
    {
      sourceStartSamples: 132896,
      sourceEndSamples: 3886880,
      timelineStartSamples: 1000000,
      timelineEndSamples: 4753984,
      hiddenSourcePrefixSamples: 49152,
      hiddenSourceSuffixSamples: 28672
    }
  );
});

test("recreates edit demo fade-in and fade-out on stereo recorded tracks", () => {
  const demoSession = sessionFromTracks([
    track("EDIT_DEMO_ST", [
      fadeEvent("EDIT_DEMO_ST", 1, "fade-in", 900, 1000),
      event({
        trackName: "EDIT_DEMO_ST",
        channel: 1,
        clipName: "EDIT_WITH_FADES.L",
        isMuted: true,
        timelineStartSamples: 1000,
        timelineEndSamples: 2000,
        sourceStartSamples: 100,
        sourceEndSamples: 1100,
        clipListSourceStartSamples: 0,
        clipListSourceEndSamples: 1200,
        sourceFile: "demo.wav"
      }),
      fadeEvent("EDIT_DEMO_ST", 1, "fade-out", 2000, 2100)
    ])
  ]);
  const recordingSession = sessionFromTracks([
    track("REC_REF_ST", [event({
      trackName: "REC_REF_ST",
      channel: 1,
      clipName: "REC_REFERENCE_FULL",
      timelineStartSamples: 10000,
      timelineEndSamples: 12000,
      sourceStartSamples: 0,
      sourceFile: "demo.wav"
    })]),
    track("REC_MAIN_ST", [1, 2].map((channel) => event({
      trackName: "REC_MAIN_ST",
      channel,
      clipName: channel === 1 ? "REC_MAIN.L" : "REC_MAIN.R",
      timelineStartSamples: 10000,
      timelineEndSamples: 12000,
      sourceStartSamples: 5000,
      sourceFile: "recording.wav"
    })))
  ]);

  const plan = conformManifest({
    demoSession,
    recordingSession,
    manifest: {
      project: "Edit Standalone Fades",
      sample_rate: 48000,
      cues: [{
        cue_id: "EDIT_FADES",
        recording_reference_track: "REC_REF_ST",
        edit_demo_track: "EDIT_DEMO_ST",
        target_tracks: [{
          recording_source_track: "REC_MAIN_ST",
          edit_destination_track: "CONF_MAIN_ST",
          fade_preset_name: "AutoEdit Equal Power"
        }]
      }]
    }
  });

  assert.equal(plan.gaps.length, 0);
  assert.deepEqual(
    plan.clips.map((clip) => ({
      channel: clip.channel,
      sourceStartSamples: clip.sourceStartSamples,
      sourceEndSamples: clip.sourceEndSamples,
      timelineStartSamples: clip.timelineStartSamples,
      timelineEndSamples: clip.timelineEndSamples
    })),
    [
      {
        channel: 1,
        sourceStartSamples: 5000,
        sourceEndSamples: 6200,
        timelineStartSamples: 900,
        timelineEndSamples: 2100
      },
      {
        channel: 2,
        sourceStartSamples: 5000,
        sourceEndSamples: 6200,
        timelineStartSamples: 900,
        timelineEndSamples: 2100
      }
    ]
  );
  assert.deepEqual(
    plan.transitions.map((transition) => ({
      type: transition.type,
      channel: transition.channel,
      timelineStartSamples: transition.timelineStartSamples,
      timelineEndSamples: transition.timelineEndSamples,
      transitionBasis: transition.transitionBasis
    })),
    [
      {
        type: "fade-in",
        channel: 1,
        timelineStartSamples: 900,
        timelineEndSamples: 1000,
        transitionBasis: "edit_demo_fade_in"
      },
      {
        type: "fade-in",
        channel: 2,
        timelineStartSamples: 900,
        timelineEndSamples: 1000,
        transitionBasis: "edit_demo_fade_in"
      },
      {
        type: "fade-out",
        channel: 1,
        timelineStartSamples: 2000,
        timelineEndSamples: 2100,
        transitionBasis: "edit_demo_fade_out"
      },
      {
        type: "fade-out",
        channel: 2,
        timelineStartSamples: 2000,
        timelineEndSamples: 2100,
        transitionBasis: "edit_demo_fade_out"
      }
    ]
  );

  const commandPlan = buildCommandPlan(plan);
  assert.equal(commandPlan.summary.fadeGroups, 2);
  assert.ok(commandPlan.clipGroups.every(group => group.spotClipsByIdRequest.clip_instance_attributes.is_muted));
  assert.deepEqual(
    commandPlan.fadeGroups.map((group) => ({
      type: group.type,
      timelineStartSamples: group.timelineStartSamples,
      timelineEndSamples: group.timelineEndSamples,
      channels: group.channels.map((channel) => channel.channel)
    })),
    [
      { type: "fade-in", timelineStartSamples: 900, timelineEndSamples: 1000, channels: [1, 2] },
      { type: "fade-out", timelineStartSamples: 2000, timelineEndSamples: 2100, channels: [1, 2] }
    ]
  );
});

test("maps edit demo crossfades through their hidden source handles", () => {
  const leftSourceStart = 157938;
  const crossfadeStart = 35147776;
  const crossfadeEnd = 35155968;
  const editBoundary = 35150621;
  const demoSession = sessionFromTracks([
    track("EDIT_DEMO_ST", [
      event({
        trackName: "EDIT_DEMO_ST",
        channel: 1,
        clipName: "strings demo-14a.L",
        timelineStartSamples: 34519506,
        timelineEndSamples: crossfadeStart,
        sourceStartSamples: leftSourceStart,
        sourceEndSamples: 786208,
        clipListSourceStartSamples: leftSourceStart,
        clipListSourceEndSamples: 789053,
        sourceFile: "strings demo.wav"
      }),
      crossfadeEvent("EDIT_DEMO_ST", 1, crossfadeStart, crossfadeEnd),
      event({
        trackName: "EDIT_DEMO_ST",
        channel: 1,
        clipName: "strings demo-14b.L",
        isMuted: true,
        timelineStartSamples: crossfadeEnd,
        timelineEndSamples: 35778560,
        sourceStartSamples: leftSourceStart,
        sourceEndSamples: 780530,
        clipListSourceStartSamples: leftSourceStart,
        clipListSourceEndSamples: 789053,
        sourceFile: "strings demo.wav"
      })
    ])
  ]);
  const recordingSession = sessionFromTracks([
    track("REC_REF_ST", [event({
      trackName: "REC_REF_ST",
      channel: 1,
      clipName: "REC_REFERENCE_FULL",
      timelineStartSamples: 315616,
      timelineEndSamples: 4300270,
      sourceStartSamples: 0,
      sourceFile: "strings demo.wav"
    })]),
    track("REC_MAIN_ST", [
      event({
        trackName: "REC_MAIN_ST",
        channel: 1,
        clipName: "REC_MAIN.L",
        timelineStartSamples: 315616,
        timelineEndSamples: 4300270,
        sourceStartSamples: 0,
        sourceFile: "recording.wav"
      }),
      event({
        trackName: "REC_MAIN_ST",
        channel: 2,
        clipName: "REC_MAIN.R",
        timelineStartSamples: 315616,
        timelineEndSamples: 4300270,
        sourceStartSamples: 0,
        sourceFile: "recording.wav"
      })
    ])
  ]);

  const plan = conformManifest({
    demoSession,
    recordingSession,
    manifest: {
      project: "Edit Crossfade",
      sample_rate: 48000,
      cues: [{
        cue_id: "EDIT_XF",
        recording_reference_track: "REC_REF_ST",
        edit_demo_track: "EDIT_DEMO_ST",
        target_tracks: [{
          recording_source_track: "REC_MAIN_ST",
          edit_destination_track: "CONF_MAIN_ST"
        }]
      }]
    }
  });

  assert.equal(plan.clips.length, 4);
  assert.deepEqual(
    plan.clips.map((clip) => ({
      channel: clip.channel,
      demoClipName: clip.demoClipName,
      timelineStartSamples: clip.timelineStartSamples,
      timelineEndSamples: clip.timelineEndSamples
    })),
    [
      { channel: 1, demoClipName: "strings demo-14a.L", timelineStartSamples: 34519506, timelineEndSamples: editBoundary },
      { channel: 2, demoClipName: "strings demo-14a.L", timelineStartSamples: 34519506, timelineEndSamples: editBoundary },
      // The unused parent tail must not extend past the playlist's actual end.
      { channel: 1, demoClipName: "strings demo-14b.L", timelineStartSamples: editBoundary, timelineEndSamples: 35778560 },
      { channel: 2, demoClipName: "strings demo-14b.L", timelineStartSamples: editBoundary, timelineEndSamples: 35778560 }
    ]
  );
  assert.equal(plan.transitions.length, 2);
  assert.deepEqual(
    plan.transitions.map((transition) => ({
      channel: transition.channel,
      timelineStartSamples: transition.timelineStartSamples,
      timelineEndSamples: transition.timelineEndSamples,
      timelineEditBoundarySamples: transition.timelineEditBoundarySamples,
      transitionBasis: transition.transitionBasis
    })),
    [
      {
        channel: 1,
        timelineStartSamples: crossfadeStart,
        timelineEndSamples: crossfadeEnd,
        timelineEditBoundarySamples: editBoundary,
        transitionBasis: "edit_demo_crossfade"
      },
      {
        channel: 2,
        timelineStartSamples: crossfadeStart,
        timelineEndSamples: crossfadeEnd,
        timelineEditBoundarySamples: editBoundary,
        transitionBasis: "edit_demo_crossfade"
      }
    ]
  );

  const commandPlan = buildCommandPlan(plan);
  assert.equal(commandPlan.summary.fadeGroups, 1);
  assert.deepEqual(commandPlan.clipGroups.map(group => group.spotClipsByIdRequest.clip_instance_attributes.is_muted), [false, true]);
  assert.equal(commandPlan.fadeGroups[0].timelineStartSamples, crossfadeStart);
  assert.equal(commandPlan.fadeGroups[0].timelineEndSamples, crossfadeEnd);
});

test("includes muted clips on explicitly selected demo, reference, and target tracks", () => {
  const demoSession = sessionFromTracks([
    track("EDIT_DEMO_ST", [event({
      trackName: "EDIT_DEMO_ST",
      channel: 1,
      clipName: "MUTED_EDIT",
      timelineStartSamples: 1000000,
      timelineEndSamples: 1001000,
      sourceStartSamples: 2000,
      sourceFile: "demo.wav",
      isMuted: true
    })])
  ]);
  const recordingSession = sessionFromTracks([
    track("REC_REF_ST", [event({
      trackName: "REC_REF_ST",
      channel: 1,
      clipName: "MUTED_REFERENCE",
      timelineStartSamples: 50000,
      timelineEndSamples: 60000,
      sourceStartSamples: 0,
      sourceFile: "demo.wav",
      isMuted: true
    })]),
    track("REC_MAIN", [event({
      trackName: "REC_MAIN",
      channel: 1,
      clipName: "MUTED_RECORDING",
      timelineStartSamples: 50000,
      timelineEndSamples: 60000,
      sourceStartSamples: 7000,
      sourceFile: "recording.wav",
      isMuted: true
    })])
  ]);

  const plan = conformManifest({
    demoSession,
    recordingSession,
    manifest: {
      project: "Muted Selected Tracks",
      sample_rate: 48000,
      cues: [{
        cue_id: "MUTED",
        recording_reference_track: "REC_REF_ST",
        edit_demo_track: "EDIT_DEMO_ST",
        target_tracks: [{
          recording_source_track: "REC_MAIN",
          edit_destination_track: "CONF_MAIN"
        }]
      }]
    }
  });

  assert.equal(plan.summary.requestedTargetTracks, 1);
  assert.equal(plan.clips.length, 1);
  assert.equal(plan.clips[0].timelineStartSamples, 1000000);
  assert.equal(plan.clips[0].sourceStartSamples, 9000);
});

test("Edit clip mute follows each occurrence across split takes and mono/stereo targets", () => {
  const demoSession = sessionFromTracks([
    track("EDIT", [false, true, false].map((isMuted, i) => event({
      trackName: "EDIT", channel: 1, clipName: "same-demo-clip",
      timelineStartSamples: 1000 + i * 1000, timelineEndSamples: 1200 + i * 1000,
      sourceStartSamples: 0, sourceFile: "demo.wav", isMuted
    })))
  ]);
  const recordingSession = sessionFromTracks([
    track("REF", [event({ trackName: "REF", channel: 1, clipName: "ref",
      timelineStartSamples: 10000, timelineEndSamples: 10200,
      sourceStartSamples: 0, sourceFile: "demo.wav", isMuted: true })]),
    ...["MONO", "STEREO"].map(name => track(name,
      (name === "MONO" ? [1] : [1, 2]).flatMap(channel => [0, 100].map(offset => event({
        trackName: name, channel, clipName: `${name}-${channel}-${offset}`,
        timelineStartSamples: 10000 + offset, timelineEndSamples: 10100 + offset,
        sourceStartSamples: offset, sourceFile: `${name}.wav`, isMuted: true
      })))
    ))
  ]);
  const manifest = { sample_rate: 48000, cues: [{
    cue_id: "MUTE", recording_reference_track: "REF", edit_demo_track: "EDIT",
    target_tracks: ["MONO", "STEREO"].map(name => ({
      recording_source_track: name, edit_destination_track: `CONF_${name}`
    }))
  }] };
  const result = conformManifest({ demoSession, recordingSession, manifest });
  assert.equal(result.clips.length, 18);
  assert.equal(result.clips.filter(c => c.isMuted).length, 6);
  const commands = buildCommandPlan(result);
  assert.equal(commands.clipGroups.length, 12);
  for (const group of commands.clipGroups) {
    const expectedMuted = group.timelineStartSamples >= 2000 && group.timelineStartSamples < 2200;
    assert.equal(group.isMuted, expectedMuted);
    assert.equal(group.channelCount, group.destinationTrack === "CONF_MONO" ? 1 : 2);
    const request = materializeSpotRequest(group, ["created-clip-id"]);
    assert.equal(request.clip_instance_attributes.is_muted, expectedMuted);
    assert.deepEqual(request.src_clips, ["created-clip-id"]);
  }
});

test("conforms stereo and mono recordings across a synthetic asymmetric crossfade", (t) => {
  const mediaDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "autoedit-crossfade-"));
  t.after(() => fs.rmSync(mediaDirectory, { recursive: true, force: true }));

  const targetNames = ["MAIN_ST", "SPOT_1", "SPOT_2", "ROOM_ST"];
  const recordingSession = sessionFromTracks(targetNames.map((name) => {
    const trackName = `REC_${name}`;
    const stereo = name.endsWith("_ST");
    const files = ["A", "B"].map((take) => {
      const sourceFile = `${trackName}_TAKE_${take}.wav`;
      const sourceFilePath = path.join(mediaDirectory, sourceFile);
      fs.writeFileSync(sourceFilePath, ""); // Preflight only checks that the path exists.
      return { sourceFile, sourceFilePath };
    });
    const events = (stereo ? [1, 2] : [1]).flatMap((channel) => {
      const suffix = stereo ? (channel === 1 ? ".L" : ".R") : "";
      return [
        event({
          trackName, channel, clipName: `${trackName}_TAKE_A${suffix}`,
          timelineStartSamples: 10000, timelineEndSamples: 30000,
          sourceStartSamples: 4000, clipListSourceStartSamples: 4000,
          clipListSourceEndSamples: 24750, ...files[0]
        }),
        crossfadeEvent(trackName, channel, 30000, 32000),
        event({
          trackName, channel, clipName: `${trackName}_TAKE_B${suffix}`,
          timelineStartSamples: 32000, timelineEndSamples: 52000,
          sourceStartSamples: 8250, clipListSourceStartSamples: 7000,
          clipListSourceEndSamples: 28250, ...files[1]
        })
      ];
    });
    return track(trackName, events);
  }));
  const demoSession = sessionFromTracks([
    track("EDIT_DEMO_ST", [
      editEvent("CUT_ACROSS_FADE", 24000, 38000, 96000)
    ])
  ]);

  const conformPlan = conformManifest({
    demoSession,
    recordingSession,
    manifest: {
      project: "Synthetic Recording Crossfade",
      sample_rate: 48000,
      cues: [
        {
          cue_id: "AUTOEDIT_XF",
          edit_demo_track: "EDIT_DEMO_ST",
          edit_demo_anchor_samples: 0,
          recording_anchor_samples: 0,
          target_tracks: targetNames.map((name) => ({
            recording_source_track: `REC_${name}`, edit_destination_track: `CONF_${name}`
          }))
        }
      ]
    }
  });

  assert.equal(conformPlan.warnings.length, 0);
  assert.equal(conformPlan.gaps.length, 0);
  assert.equal(conformPlan.clips.length, 12);
  assert.equal(conformPlan.transitions.length, 6);
  assert.deepEqual(conformPlan.summary.byDestinationTrack, {
    CONF_MAIN_ST: { clips: 4, durationSamples: 28000 },
    CONF_ROOM_ST: { clips: 4, durationSamples: 28000 },
    CONF_SPOT_1: { clips: 2, durationSamples: 14000 },
    CONF_SPOT_2: { clips: 2, durationSamples: 14000 }
  });

  const mainLeftTakeA = conformPlan.clips.find((clip) =>
    clip.destinationTrack === "CONF_MAIN_ST" &&
    clip.channel === 1 &&
    clip.sourceClipName === "REC_MAIN_ST_TAKE_A.L"
  );
  assert.deepEqual(
    {
      sourceStartSamples: mainLeftTakeA.sourceStartSamples,
      sourceEndSamples: mainLeftTakeA.sourceEndSamples,
      timelineStartSamples: mainLeftTakeA.timelineStartSamples,
      timelineEndSamples: mainLeftTakeA.timelineEndSamples,
      hiddenSourceSuffixSamples: mainLeftTakeA.hiddenSourceSuffixSamples
    },
    {
      sourceStartSamples: 18000,
      sourceEndSamples: 24750,
      timelineStartSamples: 96000,
      timelineEndSamples: 102750,
      hiddenSourceSuffixSamples: 750
    }
  );

  const mainLeftTransition = conformPlan.transitions.find((transition) =>
    transition.destinationTrack === "CONF_MAIN_ST" && transition.channel === 1
  );
  assert.deepEqual(
    {
      recordingStartSamples: mainLeftTransition.recordingStartSamples,
      recordingEndSamples: mainLeftTransition.recordingEndSamples,
      recordingEditBoundarySamples: mainLeftTransition.recordingEditBoundarySamples,
      timelineStartSamples: mainLeftTransition.timelineStartSamples,
      timelineEndSamples: mainLeftTransition.timelineEndSamples,
      timelineEditBoundarySamples: mainLeftTransition.timelineEditBoundarySamples
    },
    {
      recordingStartSamples: 30000,
      recordingEndSamples: 32000,
      recordingEditBoundarySamples: 30750,
      timelineStartSamples: 102000,
      timelineEndSamples: 104000,
      timelineEditBoundarySamples: 102750
    }
  );

  const commandPlan = buildCommandPlan(conformPlan);
  assert.deepEqual(commandPlan.summary, {
    imports: 8,
    createTracks: 4,
    clipGroups: 8,
    fadeGroups: 4,
    channelClipEntries: 12,
    transitionEntries: 6,
    warnings: 0,
    fatalIssues: 0
  });
  assert.equal(preflightCommandPlan(commandPlan).okToExecute, true);
});

function partialMappingFixture() {
  const make=(name,file,start,end,source=0)=>event({trackName:name,channel:1,clipName:name,timelineStartSamples:start,timelineEndSamples:end,sourceStartSamples:source,sourceFile:file});
  return {
    partialPolicy:true,
    demoSession:sessionFromTracks([track('EDIT',[make('EDIT','reference.wav',10000,11000,100)])]),
    recordingSession:sessionFromTracks([track('REF',[make('REF','reference.wav',500,2500)]),track('REC',[make('REC','take.wav',500,2500,3000)])]),
    manifest:{project:'Test',sample_rate:48000,cues:[{cue_id:'T',recording_reference_track:'REF',edit_demo_track:'EDIT',target_tracks:[{recording_source_track:'REC',edit_destination_track:'NEW'}]}]}
  };
}
test('partial mapping preserves a verified reference relationship',()=>{
  const p=conformManifest(partialMappingFixture());assert.equal(p.clips.length,1);assert.equal(p.clips[0].sourceStartSamples,3100);assert.equal(p.mappingDiagnostics.length,0);
});
test('user-selected references can have completely different filenames without approval',()=>{
  const f=partialMappingFixture();
  f.demoSession.tracks[0].events[0].sourceFile='another.wav';
  const p=conformManifest(f), pre=partialPreflight(buildCommandPlan(p),{exists:()=>true});
  assert.equal(p.clips[0].sourceStartSamples,3100);
  assert.equal(p.clips[0].mappingEvidence.referenceMatchBasis,'user-selected-reference');
  assert.deepEqual(p.mappingDiagnostics,[]);
  assert.equal(pre.okToExecute,true);
  assert.equal(pre.needsSkipApproval,false);
});
for(const issue of ['duplicate-reference','missing-metadata','different-rate'])test('partial mapping requires an explicit choice for '+issue,()=>{
  const f=partialMappingFixture();
  if(issue==='duplicate-reference')f.recordingSession.tracks[0].events.push({...f.recordingSession.tracks[0].events[0],timelineStartSamples:4000,timelineEndSamples:6000});
  if(issue==='missing-metadata')f.demoSession.tracks[0].events[0].mappingUnverified=true;
  if(issue==='different-rate')f.demoSession.metadata.sampleRate=96000;
  const p=conformManifest(f);
  assert.equal(p.mappingDiagnostics[0].code,'unverified-mapping');assert.equal(p.mappingDiagnostics[0].destinationTrack,'NEW');
  assert.equal(p.clips.length,issue==='different-rate'?0:1);
  const pre=partialPreflight(buildCommandPlan(p),{exists:()=>true,includeAlternatives:true});
  assert.equal(pre.summary.clipGroups,0);assert.equal(pre.okToExecute,false);
  if(issue==='different-rate')assert.equal(pre.importAnyway,undefined);
  else {assert.equal(pre.importAnyway.summary.clipGroups,1);assert.equal(pre.importAnyway.okToExecute,false);}
});
test('missing recorded track is scoped to its destination instead of dropping all group tracks',()=>{
  const f=partialMappingFixture();f.manifest.cues[0].target_tracks.push({recording_source_track:'MISSING',edit_destination_track:'OTHER'});
  const p=conformManifest(f),commands=buildCommandPlan(p);
  assert.equal(p.clips.length,1);assert.equal(commands.issues.length,1);assert.equal(commands.issues[0].destinationTrack,'OTHER');
});
