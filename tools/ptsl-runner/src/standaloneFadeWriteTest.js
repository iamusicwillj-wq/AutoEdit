#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { PtslClient, isFailure } from "./ptslClient.js";
import { phase0AssetsDir, reportsDir, exportsDir } from "./paths.js";

const sampleRate = 48000;
const expectedSessionNames = new Set(["AutoEdit Recording Test", "AutoEdit Edit Test", "AutoEdit Test"]);

function mediaPos(samples) {
  return { position: samples, time_type: "BTType_Samples" };
}

function timelineLocation(samples) {
  return { location: String(samples), time_type: "TLType_Samples" };
}

function requiredAsset(name) {
  const filePath = path.join(phase0AssetsDir, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing test asset: ${filePath}. Run npm run phase0:assets first.`);
  }
  return filePath;
}

function importedFileId(response, originalPath) {
  const entry = response.body.file_list?.find((item) => item.original_input_path === originalPath);
  const fileId = entry?.destination_file_list?.[0]?.file_id;
  if (!fileId) {
    throw new Error(`Could not find file_id for ${originalPath}: ${JSON.stringify(response.body)}`);
  }
  return fileId;
}

function createdClipId(response, label) {
  const clipId = response.body.clip_list?.[0]?.clip_ids?.[0];
  if (!clipId) {
    throw new Error(`CreateAudioClips returned no clip ID for ${label}: ${JSON.stringify(response.body)}`);
  }
  return clipId;
}

async function exportSessionInfo(client, outputPath) {
  return client.send("ExportSessionInfoAsText", {
    include_file_list: true,
    include_clip_list: true,
    include_markers: true,
    include_plugin_list: false,
    include_track_edls: true,
    show_sub_frames: true,
    include_user_timestamps: true,
    track_list_type: "TListType_AllTracks",
    fade_handling_type: "FHType_ShowCrossfades",
    text_as_file_format: "TFFormat_UTF8",
    output_type: "ESIOType_File",
    output_path: outputPath,
    location_type: "TLType_Samples"
  });
}

async function main() {
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const trackName = `PTSL_Fade_Test_${runId}`;
  const clipName = `${trackName}_Clip`;
  const timelineStart = sampleRate * 30;
  const clipDuration = sampleRate * 3;
  const timelineEnd = timelineStart + clipDuration;
  const fadeDuration = Math.round(sampleRate * 0.125);
  const exportPath = path.join(exportsDir, `standalone_fade_write_test_${runId}_session_info.txt`);
  const reportPath = path.join(reportsDir, `standalone-fade-write-test-${Date.now()}.json`);
  const assetPath = requiredAsset("phase0_mono_take_a.wav");

  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(exportsDir, { recursive: true });

  const client = new PtslClient();
  const results = [];
  const created = {
    session: "",
    trackName,
    clipName,
    timelineStart,
    timelineEnd,
    fadeDuration,
    exportPath
  };

  try {
    results.push(await client.register({
      companyName: "Auto Edit",
      applicationName: "PTSL Standalone Fade Write Test"
    }));

    const sessionName = await client.send("GetSessionName");
    results.push(sessionName);
    created.session = sessionName.body.session_name ?? "";
    if (!expectedSessionNames.has(created.session)) {
      throw new Error(`Refusing to write fade test into non-test session: ${created.session}`);
    }

    results.push(await client.send("HostReadyCheck"));
    results.push(await client.send("CreateNewTracks", {
      number_of_tracks: 1,
      track_name: trackName,
      track_format: "TFormat_Mono",
      track_type: "TType_Audio",
      track_timebase: "TTimebase_Samples"
    }));

    const importResponse = await client.send("ImportAudioToClipList", {
      file_list: [assetPath],
      audio_operations: "AOperations_AddAudio"
    });
    results.push(importResponse);

    const createResponse = await client.send("CreateAudioClips", {
      clip_list: [{
        name: clipName,
        clip_info: [{
          file_id: importedFileId(importResponse, assetPath),
          src_start_point: mediaPos(sampleRate),
          src_end_point: mediaPos(sampleRate + clipDuration)
        }]
      }]
    });
    results.push(createResponse);

    results.push(await client.send("SpotClipsByID", {
      src_clips: [createdClipId(createResponse, clipName)],
      dst_track_name: trackName,
      dst_location_data: {
        location_type: "SLType_Start",
        location: timelineLocation(timelineStart)
      }
    }));

    results.push(await client.send("SelectTracksByName", {
      track_names: [trackName],
      selection_mode: "SMode_Replace",
      pagination_request: { limit: 100, offset: 0 }
    }));

    for (const [selectionStart, selectionEnd] of [
      [timelineStart, timelineStart + fadeDuration],
      [timelineEnd - fadeDuration, timelineEnd]
    ]) {
      results.push(await client.send("SetTimelineSelection", {
        in_time: String(selectionStart),
        out_time: String(selectionEnd),
        location_type: "TLType_Samples"
      }));
      results.push(await client.send("CreateFadesBasedOnPreset", {
        auto_adjust_bounds: true
      }));
    }

    results.push(await exportSessionInfo(client, exportPath));
  } finally {
    client.close();
  }

  const report = { created, results };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const exportedText = fs.existsSync(exportPath) ? fs.readFileSync(exportPath, "utf8") : "";
  const trackBlock = exportedText.split("TRACK NAME:").find((block) => block.startsWith(`\t${trackName}`)) ?? "";
  const fadeInFound = /\(fade in\)/i.test(trackBlock);
  const fadeOutFound = /\(fade out\)/i.test(trackBlock);
  const output = {
    reportPath,
    ...created,
    failedCommands: results.filter(isFailure).length,
    fadeInFound,
    fadeOutFound,
    trackBlock: trackBlock.split("\n").slice(0, 20).join("\n")
  };

  console.log(JSON.stringify(output, null, 2));
  if (results.some(isFailure) || !fadeInFound || !fadeOutFound) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
