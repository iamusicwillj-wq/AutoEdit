#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { PtslClient, loadSavedSessionId, isFailure } from "./ptslClient.js";
import { exportsDir } from "./paths.js";

function usage() {
  console.log(`Usage:
  npm run export-session-info -- [--output <session_info.txt>] [--selected-tracks]

This is read-only: it calls ExportSessionInfoAsText and writes Pro Tools session info to a text file.
`);
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? "" : args[index + 1] ?? "";
}

function defaultOutputPath() {
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return path.join(exportsDir, `session_info_${runId}.txt`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const outputPath = path.resolve(argValue(args, "--output") || defaultOutputPath());
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const client = new PtslClient({ sessionId: loadSavedSessionId() });
  const results = [];
  try {
    if (!client.sessionId) {
      results.push(await client.register({
        companyName: "Auto Edit",
        applicationName: "PTSL Music Conformer"
      }));
    }

    const response = await client.send("ExportSessionInfoAsText", {
      include_file_list: true,
      include_clip_list: true,
      include_markers: true,
      include_plugin_list: false,
      include_track_edls: true,
      show_sub_frames: true,
      include_user_timestamps: true,
      track_list_type: args.includes("--selected-tracks")
        ? "TListType_SelectedTracksOnly"
        : "TListType_AllTracks",
      fade_handling_type: "FHType_ShowCrossfades",
      text_as_file_format: "TFFormat_UTF8",
      output_type: "ESIOType_File",
      output_path: outputPath,
      location_type: "TLType_Samples"
    });
    results.push(response);

    console.log(`Exported session info: ${outputPath}`);
    console.log(JSON.stringify(results, null, 2));
    if (results.some(isFailure)) {
      process.exitCode = 2;
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
