#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { PtslClient, isFailure } from "./ptslClient.js";
import { reportsDir, runnerRoot } from "./paths.js";

const sampleRate = 48000;
const bitDepth = 16;
const expectedSessionName = "AutoEdit Edit Test";
const scenarioAssetsDir = path.join(runnerRoot, "scenario", "edit-assets");

const track = { name: "EDIT_DEMO_ST", format: "TFormat_Stereo" };
const editSegments = [
  {
    id: "CUT_01",
    sourceStart: sampleRate * 2,
    sourceEnd: sampleRate * 4,
    timelineStart: sampleRate * 20
  },
  {
    id: "CUT_02_CROSSES_REC_GAP",
    sourceStart: sampleRate * 4,
    sourceEnd: sampleRate * 6.25,
    timelineStart: sampleRate * 22
  },
  {
    id: "CUT_03",
    sourceStart: sampleRate * 6.5,
    sourceEnd: sampleRate * 8,
    timelineStart: sampleRate * 24.25
  },
  {
    id: "CUT_04",
    sourceStart: sampleRate * 8,
    sourceEnd: sampleRate * 9.5,
    timelineStart: sampleRate * 25.75
  }
].map((segment) => ({
  ...segment,
  timelineEnd: segment.timelineStart + (segment.sourceEnd - segment.sourceStart)
}));

function writeAscii(buffer, offset, value) {
  buffer.write(value, offset, value.length, "ascii");
}

function makeWav({ filePath, channels, seconds, tones }) {
  const frames = Math.floor(sampleRate * seconds);
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  writeAscii(buffer, 0, "RIFF");
  buffer.writeUInt32LE(36 + dataSize, 4);
  writeAscii(buffer, 8, "WAVE");
  writeAscii(buffer, 12, "fmt ");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  writeAscii(buffer, 36, "data");
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.min(1, i / 1200, (frames - i) / 1200);
    for (let ch = 0; ch < channels; ch += 1) {
      const freq = tones[ch] ?? tones[0];
      const value = Math.round(Math.sin(2 * Math.PI * freq * t) * 0.22 * 32767 * envelope);
      buffer.writeInt16LE(value, offset);
      offset += 2;
    }
  }

  fs.writeFileSync(filePath, buffer);
}

function ensureScenarioAsset() {
  fs.mkdirSync(scenarioAssetsDir, { recursive: true });
  const filePath = path.join(scenarioAssetsDir, "edit_demo_st.wav");
  if (!fs.existsSync(filePath)) {
    makeWav({ filePath, channels: 2, seconds: 12, tones: [250, 375] });
  }
  return filePath;
}

function mediaPos(samples) {
  return { position: samples, time_type: "BTType_Samples" };
}

function timelineLocation(samples) {
  return { location: String(samples), time_type: "TLType_Samples" };
}

function firstImportedFileId(importResponse, originalPath) {
  const entry = importResponse.body.file_list?.find((item) => item.original_input_path === originalPath);
  const fileId = entry?.destination_file_list?.[0]?.file_id;
  if (!fileId) {
    throw new Error(`Could not find file_id for ${originalPath}: ${JSON.stringify(importResponse.body)}`);
  }
  return fileId;
}

function existingScenarioTracks(trackListResponse) {
  const existingNames = new Set((trackListResponse.body.track_list ?? []).map((item) => item.name));
  return existingNames.has(track.name) ? [track.name] : [];
}

function stereoClipInfo(fileId, start, end) {
  return [
    {
      file_id: fileId,
      src_channel: { name: "SChannel_Left" },
      dst_channel: { name: "SChannel_Left" },
      src_start_point: mediaPos(start),
      src_end_point: mediaPos(end)
    },
    {
      file_id: fileId,
      src_channel: { name: "SChannel_Right" },
      dst_channel: { name: "SChannel_Right" },
      src_start_point: mediaPos(start),
      src_end_point: mediaPos(end)
    }
  ];
}

function createClipRequest({ fileId, segment }) {
  return {
    clip_list: [
      {
        name: `${track.name}_${segment.id}`,
        channel_format: "SFormat_Stereo",
        clip_info: stereoClipInfo(fileId, segment.sourceStart, segment.sourceEnd)
      }
    ]
  };
}

async function spotCreatedClip(client, results, createResponse, timelineStart) {
  const clipIds = createResponse.body.clip_list?.[0]?.clip_ids ?? [];
  if (!clipIds.length) {
    throw new Error(`CreateAudioClips returned no clip IDs: ${JSON.stringify(createResponse.body)}`);
  }
  const response = await client.send("SpotClipsByID", {
    src_clips: clipIds,
    dst_track_name: track.name,
    dst_location_data: {
      location_type: "SLType_Start",
      location: timelineLocation(timelineStart)
    }
  });
  results.push(response);
  return clipIds;
}

async function main() {
  const assetPath = ensureScenarioAsset();
  fs.mkdirSync(reportsDir, { recursive: true });

  const client = new PtslClient();
  const results = [];
  const created = {
    session: "",
    track: track.name,
    editSegments,
    clipIdsBySegment: {}
  };

  try {
    results.push(await client.register({
      companyName: "Auto Edit",
      applicationName: "PTSL Edit Scenario"
    }));

    const sessionName = await client.send("GetSessionName");
    results.push(sessionName);
    created.session = sessionName.body.session_name ?? "";
    if (created.session !== expectedSessionName) {
      throw new Error(`Expected session "${expectedSessionName}", got "${created.session}"`);
    }

    results.push(await client.send("HostReadyCheck"));
    results.push(await client.send("GetSessionSampleRate"));

    const trackList = await client.send("GetTrackList", { track_filter: "" });
    results.push(trackList);
    const duplicateTracks = existingScenarioTracks(trackList);
    if (duplicateTracks.length) {
      throw new Error(
        `Edit scenario tracks already exist in "${created.session}": ${duplicateTracks.join(", ")}. ` +
        "Create a clean test session before rerunning this writer."
      );
    }

    results.push(await client.send("CreateNewTracks", {
      number_of_tracks: 1,
      track_name: track.name,
      track_format: track.format,
      track_type: "TType_Audio",
      track_timebase: "TTimebase_Samples"
    }));

    const importResponse = await client.send("ImportAudioToClipList", {
      file_list: [assetPath],
      audio_operations: "AOperations_AddAudio"
    });
    results.push(importResponse);
    const fileId = firstImportedFileId(importResponse, assetPath);

    for (const segment of editSegments) {
      const createResponse = await client.send("CreateAudioClips", createClipRequest({ fileId, segment }));
      results.push(createResponse);
      created.clipIdsBySegment[segment.id] = await spotCreatedClip(
        client,
        results,
        createResponse,
        segment.timelineStart
      );
    }
  } finally {
    client.close();
  }

  const report = {
    created,
    results
  };
  const reportPath = path.join(reportsDir, `edit-scenario-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Wrote edit scenario report: ${reportPath}`);
  console.log(JSON.stringify({
    session: created.session,
    track: created.track,
    editSegments: created.editSegments,
    failedCommands: results.filter(isFailure).length
  }, null, 2));

  if (results.some(isFailure)) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
