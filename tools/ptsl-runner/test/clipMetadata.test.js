import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { enrichSessionWithClipMetadata } from "../src/clipMetadata.js";
import { parseSessionInfoText } from "../src/sessionInfoParser.js";

const fixture = fs.readFileSync(new URL("./fixtures/session_info_minimal.txt", import.meta.url), "utf8");

test("enriches EDL events with exact GetClipList source ranges", () => {
  const session = parseSessionInfoText(fixture);
  const enriched = enrichSessionWithClipMetadata(session, {
    clips: [
      {
        clip_full_name: "takeA-01",
        clip_id: "clip-a",
        file_id: "file-a",
        is_online: true,
        src_start_point: { position: "123", time_type: "BTType_Samples" },
        src_end_point: { position: "1423", time_type: "BTType_Samples" }
      }
    ],
    file_locations: [
      {
        file_id: "file-a",
        path: "/Session/Audio Files/takeA.wav",
        info: { is_online: true }
      }
    ]
  });

  const event = enriched.tracks
    .find((track) => track.name === "REC_VLN")
    .events
    .find((item) => item.clipName === "takeA-01");

  assert.equal(event.fileId, "file-a");
  assert.equal(event.clipId, "clip-a");
  assert.equal(event.clipIsOnline, true);
  assert.equal(event.sourceFileOnline, true);
  assert.equal(event.sourceStartSamples, 123);
  assert.equal(event.sourceEndSamples, 1423);
  assert.equal(event.clipListSourceStartSamples, 123);
  assert.equal(event.clipListSourceEndSamples, 1423);
  assert.equal(event.sourceRangeBasis, "get_clip_list_start_plus_timeline_duration");
  assert.equal(event.sourceFilePath, "/Session/Audio Files/takeA.wav");
});

test("uses GetClipList source start with timeline duration when clip-list source has handles", () => {
  const session = parseSessionInfoText(fixture);
  const enriched = enrichSessionWithClipMetadata(session, {
    clips: [
      {
        clip_full_name: "takeA-01",
        clip_id: "clip-a",
        file_id: "file-a",
        src_start_point: { position: "123", time_type: "BTType_Samples" },
        src_end_point: { position: "9999", time_type: "BTType_Samples" }
      }
    ],
    file_locations: []
  });

  const event = enriched.tracks
    .find((track) => track.name === "REC_VLN")
    .events
    .find((item) => item.clipName === "takeA-01");

  assert.equal(event.durationSamples, 1300);
  assert.equal(event.sourceStartSamples, 123);
  assert.equal(event.sourceEndSamples, 1423);
  assert.equal(event.clipListSourceEndSamples, 9999);
});

test("allows duplicate GetClipList entries when their source ranges are identical", () => {
  const session = parseSessionInfoText(fixture);
  const enriched = enrichSessionWithClipMetadata(session, {
    clips: [
      {
        clip_full_name: "takeA-01",
        clip_id: "clip-a-1",
        file_id: "file-a",
        is_online: true,
        src_start_point: { position: "123", time_type: "BTType_Samples" },
        src_end_point: { position: "9999", time_type: "BTType_Samples" }
      },
      {
        clip_full_name: "takeA-01",
        clip_id: "clip-a-2",
        file_id: "file-a",
        is_online: true,
        src_start_point: { position: "123", time_type: "BTType_Samples" },
        src_end_point: { position: "9999", time_type: "BTType_Samples" }
      }
    ],
    file_locations: [
      {
        file_id: "file-a",
        path: "/Session/Audio Files/takeA.wav",
        info: { is_online: true }
      }
    ]
  });

  const event = enriched.tracks
    .find((track) => track.name === "REC_VLN")
    .events
    .find((item) => item.clipName === "takeA-01");

  assert.equal(event.sourceStartSamples, 123);
  assert.equal(event.sourceEndSamples, 1423);
  assert.equal(
    enriched.warnings.some((warning) => warning.includes("ambiguous") && warning.includes("takeA-01")),
    false
  );
});

test('source handles use verified ranges from other online clips of the same file only', () => {
  const enriched = enrichSessionWithClipMetadata(parseSessionInfoText(fixture), {
    clips: [
      {clip_full_name:'takeA-01',file_id:'file-a',src_start_point:{position:'123'},src_end_point:{position:'1423'}},
      {clip_full_name:'whole-file',file_id:'file-a',src_start_point:{position:'0'},src_end_point:{position:'5000'}},
      {clip_full_name:'offline',file_id:'file-a',is_online:false,src_end_point:{position:'99999'}},
      {clip_full_name:'other',file_id:'file-b',src_end_point:{position:'999999'}}
    ]
  });
  const event=enriched.tracks.find(t=>t.name==='REC_VLN').events.find(e=>e.clipName==='takeA-01');
  assert.equal(event.sourceFileKnownEndSamples,5000);
});
