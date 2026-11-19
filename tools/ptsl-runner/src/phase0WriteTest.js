import fs from "node:fs";
import path from "node:path";
import { PtslClient, isFailure } from "./ptslClient.js";
import { phase0AssetsDir, phase0ReportsDir } from "./paths.js";

const sampleRate = 48000;

function requiredAsset(name) {
  const filePath = path.join(phase0AssetsDir, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing test asset: ${filePath}. Run npm run phase0:assets first.`);
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

async function main() {
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const monoTrackName = `PTSL_Phase0_Mono_${runId}`;
  const stereoTrackName = `PTSL_Phase0_Stereo_${runId}`;

  const assets = {
    monoA: requiredAsset("phase0_mono_take_a.wav"),
    monoB: requiredAsset("phase0_mono_take_b.wav"),
    stereo: requiredAsset("phase0_stereo_take.wav")
  };

  fs.mkdirSync(phase0ReportsDir, { recursive: true });

  const client = new PtslClient();
  const results = [];

  try {
    results.push(await client.register());
    results.push(await client.send("HostReadyCheck"));
    results.push(await client.send("GetSessionSampleRate"));

    results.push(await client.send("CreateNewTracks", {
      number_of_tracks: 1,
      track_name: monoTrackName,
      track_format: "TFormat_Mono",
      track_type: "TType_Audio",
      track_timebase: "TTimebase_Samples"
    }));

    results.push(await client.send("CreateNewTracks", {
      number_of_tracks: 1,
      track_name: stereoTrackName,
      track_format: "TFormat_Stereo",
      track_type: "TType_Audio",
      track_timebase: "TTimebase_Samples"
    }));

    const importResponse = await client.send("ImportAudioToClipList", {
      file_list: [assets.monoA, assets.monoB, assets.stereo],
      audio_operations: "AOperations_AddAudio"
    });
    results.push(importResponse);

    const monoAFileId = firstImportedFileId(importResponse, assets.monoA);
    const monoBFileId = firstImportedFileId(importResponse, assets.monoB);
    const stereoFileId = firstImportedFileId(importResponse, assets.stereo);

    const createMonoA = await client.send("CreateAudioClips", {
      clip_list: [
        {
          name: "PTSL_Phase0_Mono_A_mid",
          clip_info: [
            {
              file_id: monoAFileId,
                  src_start_point: mediaPos(sampleRate * 2),
                  src_end_point: mediaPos(sampleRate * 5)
                }
              ]
        }
      ]
    });
    results.push(createMonoA);

    const createMonoB = await client.send("CreateAudioClips", {
      clip_list: [
        {
          name: "PTSL_Phase0_Mono_B_mid",
          clip_info: [
            {
              file_id: monoBFileId,
                  src_start_point: mediaPos(sampleRate * 1),
                  src_end_point: mediaPos(sampleRate * 4)
                }
              ]
        }
      ]
    });
    results.push(createMonoB);

    const monoClipA = createMonoA.body.clip_list?.[0]?.clip_ids?.[0];
    const monoClipB = createMonoB.body.clip_list?.[0]?.clip_ids?.[0];
    if (!monoClipA || !monoClipB) {
      throw new Error(`CreateAudioClips did not return mono clip IDs: ${JSON.stringify({
        createMonoA: createMonoA.body,
        createMonoB: createMonoB.body
      })}`);
    }

    const createStereo = await client.send("CreateAudioClips", {
      clip_list: [
        {
          name: "PTSL_Phase0_Stereo_mid",
          channel_format: "SFormat_Stereo",
          clip_info: [
            {
              file_id: stereoFileId,
              src_channel: { name: "SChannel_Left" },
              dst_channel: { name: "SChannel_Left" },
              src_start_point: mediaPos(sampleRate * 3),
              src_end_point: mediaPos(sampleRate * 7)
            },
            {
              file_id: stereoFileId,
              src_channel: { name: "SChannel_Right" },
              dst_channel: { name: "SChannel_Right" },
              src_start_point: mediaPos(sampleRate * 3),
              src_end_point: mediaPos(sampleRate * 7)
            }
          ]
        }
      ]
    });
    results.push(createStereo);

    const stereoClipIds = createStereo.body.clip_list?.[0]?.clip_ids ?? [];
    if (stereoClipIds.length < 2) {
      throw new Error(`CreateAudioClips did not return stereo clip IDs: ${JSON.stringify(createStereo.body)}`);
    }

    results.push(await client.send("SpotClipsByID", {
      src_clips: [monoClipA],
      dst_track_name: monoTrackName,
      dst_location_data: {
        location_type: "SLType_Start",
        location: timelineLocation(sampleRate * 1)
      },
      clip_instance_attributes: { color_index: 61 }
    }));

    results.push(await client.send("SpotClipsByID", {
      src_clips: [monoClipB],
      dst_track_name: monoTrackName,
      dst_location_data: {
        location_type: "SLType_Start",
        location: timelineLocation(sampleRate * 6)
      },
      clip_instance_attributes: { color_index: 62 }
    }));

    results.push(await client.send("SpotClipsByID", {
      src_clips: stereoClipIds,
      dst_track_name: stereoTrackName,
      dst_location_data: {
        location_type: "SLType_Start",
        location: timelineLocation(sampleRate * 10)
      },
      clip_instance_attributes: { color_index: 63 }
    }));
  } finally {
    client.close();
  }

  const reportPath = path.join(phase0ReportsDir, `phase0-write-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`Wrote report: ${reportPath}`);
  console.log(JSON.stringify(results, null, 2));

  if (results.some(isFailure)) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
