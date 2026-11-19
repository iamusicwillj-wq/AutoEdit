import fs from "node:fs";
import path from "node:path";
import { PtslClient } from "./ptslClient.js";
import { phase0AssetsDir, phase0ReportsDir } from "./paths.js";

const sampleRate = 48000;

function mediaPos(samples) {
  return { position: samples, time_type: "BTType_Samples" };
}

function clipIds(response) {
  return response.body.clip_list?.flatMap((entry) => entry.clip_ids ?? []) ?? [];
}

async function main() {
  const monoPath = path.join(phase0AssetsDir, "phase0_mono_take_a.wav");
  if (!fs.existsSync(monoPath)) {
    throw new Error(`Missing test asset: ${monoPath}. Run npm run phase0:assets first.`);
  }

  fs.mkdirSync(phase0ReportsDir, { recursive: true });
  const client = new PtslClient();
  const results = [];

  try {
    results.push(await client.register());

    const imported = await client.send("ImportAudioToClipList", {
      file_list: [monoPath],
      audio_operations: "AOperations_AddAudio"
    });
    results.push(imported);

    const fileId = imported.body.file_list?.[0]?.destination_file_list?.[0]?.file_id;
    const wholeFileClipId = imported.body.file_list?.[0]?.destination_file_list?.[0]?.clip_id_list?.[0];
    if (!fileId) {
      throw new Error(`ImportAudioToClipList did not return file_id: ${JSON.stringify(imported.body)}`);
    }

    results.push(await client.send("GetMediaFileInfo", { file_id: fileId }));

    const variants = [
      {
        label: "file-id-only",
        request: {
          clip_list: [
            {
              name: "PTSL_probe_file_id_only",
              clip_info: [{ file_id: fileId }]
            }
          ]
        }
      },
      {
        label: "file-id-source-range-no-format",
        request: {
          clip_list: [
            {
              name: "PTSL_probe_range_no_format",
              clip_info: [
                {
                  file_id: fileId,
                  src_start_point: mediaPos(sampleRate * 2),
                  src_end_point: mediaPos(sampleRate * 5)
                }
              ]
            }
          ]
        }
      },
      {
        label: "file-id-source-range-with-start-end",
        request: {
          clip_list: [
            {
              name: "PTSL_probe_range_dest_bounds",
              clip_info: [
                {
                  file_id: fileId,
                  src_start_point: mediaPos(sampleRate * 2),
                  src_end_point: mediaPos(sampleRate * 5),
                  start_point: mediaPos(0),
                  end_point: mediaPos(sampleRate * 3)
                }
              ]
            }
          ]
        }
      },
      {
        label: "file-id-source-range-mono-format",
        request: {
          clip_list: [
            {
              name: "PTSL_probe_range_mono_format",
              channel_format: "SFormat_Mono",
              clip_info: [
                {
                  file_id: fileId,
                  src_channel: { name: "SChannel_Mono" },
                  dst_channel: { name: "SChannel_Mono" },
                  src_start_point: mediaPos(sampleRate * 2),
                  src_end_point: mediaPos(sampleRate * 5)
                }
              ]
            }
          ]
        }
      }
    ];

    if (wholeFileClipId) {
      variants.push({
        label: "whole-file-clip-id-is-not-file-id-control",
        request: {
          clip_list: [
            {
              name: "PTSL_probe_using_clip_id_control",
              clip_info: [
                {
                  file_id: wholeFileClipId,
                  src_start_point: mediaPos(sampleRate * 2),
                  src_end_point: mediaPos(sampleRate * 5)
                }
              ]
            }
          ]
        }
      });
    }

    for (const variant of variants) {
      const response = await client.send("CreateAudioClips", variant.request);
      results.push({ label: variant.label, request: variant.request, response, created_clip_ids: clipIds(response) });
    }
  } finally {
    client.close();
  }

  const reportPath = path.join(phase0ReportsDir, `phase0-probe-create-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`Wrote report: ${reportPath}`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
