#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { PtslClient, isFailure } from "./ptslClient.js";
import { reportsDir, runnerRoot } from "./paths.js";

const sampleRate = 48000;
const bitDepth = 16;
const expectedSessionName = "AutoEdit Recording Test";
const scenarioAssetsDir = path.join(runnerRoot, "scenario", "recording-assets");

const tracks = [
  { name: "REC_REF_ST", format: "TFormat_Stereo" },
  { name: "REC_MAIN_ST", format: "TFormat_Stereo", micGroup: true },
  { name: "REC_SPOT_VLN1_M1", format: "TFormat_Mono", micGroup: true },
  { name: "REC_SPOT_VLN1_M2", format: "TFormat_Mono", micGroup: true },
  { name: "REC_ROOM_ST", format: "TFormat_Stereo", micGroup: true }
];

const takes = [
  {
    id: "TAKE_A",
    timelineStart: sampleRate * 2,
    timelineEnd: sampleRate * 6,
    sourceStart: sampleRate * 1
  },
  {
    id: "TAKE_B",
    timelineStart: sampleRate * 6.5,
    timelineEnd: sampleRate * 10,
    sourceStart: sampleRate * 2
  }
];

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

function ensureScenarioAssets() {
  fs.mkdirSync(scenarioAssetsDir, { recursive: true });
  const assets = [
    { key: "REC_REF_ST", name: "rec_ref_st.wav", channels: 2, seconds: 12, tones: [250, 375] },
    { key: "REC_MAIN_ST_TAKE_A", name: "rec_main_st_take_a.wav", channels: 2, seconds: 8, tones: [330, 440] },
    { key: "REC_MAIN_ST_TAKE_B", name: "rec_main_st_take_b.wav", channels: 2, seconds: 8, tones: [350, 465] },
    { key: "REC_SPOT_VLN1_M1_TAKE_A", name: "rec_spot_vln1_m1_take_a.wav", channels: 1, seconds: 8, tones: [520] },
    { key: "REC_SPOT_VLN1_M1_TAKE_B", name: "rec_spot_vln1_m1_take_b.wav", channels: 1, seconds: 8, tones: [545] },
    { key: "REC_SPOT_VLN1_M2_TAKE_A", name: "rec_spot_vln1_m2_take_a.wav", channels: 1, seconds: 8, tones: [610] },
    { key: "REC_SPOT_VLN1_M2_TAKE_B", name: "rec_spot_vln1_m2_take_b.wav", channels: 1, seconds: 8, tones: [635] },
    { key: "REC_ROOM_ST_TAKE_A", name: "rec_room_st_take_a.wav", channels: 2, seconds: 8, tones: [220, 280] },
    { key: "REC_ROOM_ST_TAKE_B", name: "rec_room_st_take_b.wav", channels: 2, seconds: 8, tones: [235, 295] }
  ];

  const byKey = new Map();
  for (const asset of assets) {
    const filePath = path.join(scenarioAssetsDir, asset.name);
    if (!fs.existsSync(filePath)) {
      makeWav({ filePath, ...asset });
    }
    byKey.set(asset.key, filePath);
  }
  return byKey;
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

function monoClipInfo(fileId, start, end) {
  return [
    {
      file_id: fileId,
      src_start_point: mediaPos(start),
      src_end_point: mediaPos(end)
    }
  ];
}

function sourceAssetKey(trackName, takeId) {
  return `${trackName}_${takeId}`;
}

function existingScenarioTracks(trackListResponse) {
  const existingNames = new Set((trackListResponse.body.track_list ?? []).map((track) => track.name));
  return tracks.map((track) => track.name).filter((name) => existingNames.has(name));
}

function createClipRequest({ trackName, take, fileId, isStereo }) {
  const duration = take.timelineEnd - take.timelineStart;
  const sourceEnd = take.sourceStart + duration;
  return {
    clip_list: [
      {
        name: `${trackName}_${take.id}`,
        ...(isStereo ? { channel_format: "SFormat_Stereo" } : {}),
        clip_info: isStereo
          ? stereoClipInfo(fileId, take.sourceStart, sourceEnd)
          : monoClipInfo(fileId, take.sourceStart, sourceEnd)
      }
    ]
  };
}

async function spotCreatedClip(client, results, createResponse, trackName, timelineStart) {
  const clipIds = createResponse.body.clip_list?.[0]?.clip_ids ?? [];
  if (!clipIds.length) {
    throw new Error(`CreateAudioClips returned no clip IDs for ${trackName}: ${JSON.stringify(createResponse.body)}`);
  }
  const response = await client.send("SpotClipsByID", {
    src_clips: clipIds,
    dst_track_name: trackName,
    dst_location_data: {
      location_type: "SLType_Start",
      location: timelineLocation(timelineStart)
    }
  });
  results.push(response);
  return clipIds;
}

async function main() {
  const assetsByKey = ensureScenarioAssets();
  fs.mkdirSync(reportsDir, { recursive: true });

  const client = new PtslClient();
  const results = [];
  const created = {
    session: "",
    tracks: tracks.map((track) => track.name),
    takes,
    clipIdsByTrackAndTake: {}
  };

  try {
    results.push(await client.register({
      companyName: "Auto Edit",
      applicationName: "PTSL Recording Scenario"
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
        `Recording scenario tracks already exist in "${created.session}": ${duplicateTracks.join(", ")}. ` +
        "Create a clean test session before rerunning this writer."
      );
    }

    for (const track of tracks) {
      results.push(await client.send("CreateNewTracks", {
        number_of_tracks: 1,
        track_name: track.name,
        track_format: track.format,
        track_type: "TType_Audio",
        track_timebase: "TTimebase_Samples"
      }));
    }

    const importPaths = [...assetsByKey.values()];
    const importResponse = await client.send("ImportAudioToClipList", {
      file_list: importPaths,
      audio_operations: "AOperations_AddAudio"
    });
    results.push(importResponse);

    const fileIdByKey = new Map();
    for (const [key, filePath] of assetsByKey.entries()) {
      fileIdByKey.set(key, firstImportedFileId(importResponse, filePath));
    }

    const refCreate = await client.send("CreateAudioClips", {
      clip_list: [
        {
          name: "REC_REF_ST_FULL",
          channel_format: "SFormat_Stereo",
          clip_info: stereoClipInfo(fileIdByKey.get("REC_REF_ST"), 0, sampleRate * 12)
        }
      ]
    });
    results.push(refCreate);
    created.clipIdsByTrackAndTake.REC_REF_ST_FULL = await spotCreatedClip(
      client,
      results,
      refCreate,
      "REC_REF_ST",
      0
    );

    for (const take of takes) {
      for (const track of tracks.filter((item) => item.micGroup)) {
        const isStereo = track.format === "TFormat_Stereo";
        const key = sourceAssetKey(track.name, take.id);
        const createResponse = await client.send("CreateAudioClips", createClipRequest({
          trackName: track.name,
          take,
          fileId: fileIdByKey.get(key),
          isStereo
        }));
        results.push(createResponse);
        created.clipIdsByTrackAndTake[`${track.name}_${take.id}`] = await spotCreatedClip(
          client,
          results,
          createResponse,
          track.name,
          take.timelineStart
        );
      }
    }
  } finally {
    client.close();
  }

  const report = {
    created,
    results
  };
  const reportPath = path.join(reportsDir, `recording-scenario-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Wrote recording scenario report: ${reportPath}`);
  console.log(JSON.stringify({
    session: created.session,
    tracks: created.tracks,
    takes: created.takes,
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
