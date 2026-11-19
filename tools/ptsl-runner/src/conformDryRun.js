#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { enrichSessionWithClipMetadata } from "./clipMetadata.js";
import { conformManifest } from "./conformEngine.js";
import { parseSessionInfoFile } from "./sessionInfoParser.js";
import { reportsDir } from "./paths.js";

function usage() {
  console.log(`Usage:
  npm run conform:dry-run -- --manifest <manifest.json> --edit-info <music_edit_session_info.txt> --recording-info <recording_session_info.txt> [--edit-clip-metadata <json>] [--recording-clip-metadata <json>] [--output <plan.json>]

Backwards-compatible aliases:
  --demo-info == --edit-info
  --demo-clip-metadata == --edit-clip-metadata
`);
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? "" : args[index + 1] ?? "";
}

function defaultOutputPath() {
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return path.join(reportsDir, `conform-dry-run-${runId}.json`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function parseRequiredSession(filePath, label) {
  const session = parseSessionInfoFile(path.resolve(filePath));
  const declaredTracks = session.metadata.audioTrackCount ?? 0;
  if (declaredTracks > 0 && session.tracks.length === 0) {
    throw new Error(
      `${label} Session Info declares ${declaredTracks} audio tracks, but AutoEdit could not parse its track listing. `
      + "Re-export Session Info and check the Pro Tools language/format."
    );
  }
  return session;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const manifestPath = argValue(args, "--manifest");
  const editInfoPath = argValue(args, "--edit-info") || argValue(args, "--demo-info");
  const recordingInfoPath = argValue(args, "--recording-info");
  if (!manifestPath || !editInfoPath || !recordingInfoPath) {
    usage();
    throw new Error("Missing --manifest, --edit-info, or --recording-info");
  }

  const editClipMetadataPath = argValue(args, "--edit-clip-metadata") || argValue(args, "--demo-clip-metadata");
  const recordingClipMetadataPath = argValue(args, "--recording-clip-metadata");

  const editSession = parseRequiredSession(editInfoPath, "Edit");
  const recordingSession = parseRequiredSession(recordingInfoPath, "Recording");
  const plan = conformManifest({
    partialPolicy: args.includes("--partial-policy"),
    manifest: readJson(manifestPath),
    demoSession: editClipMetadataPath
      ? enrichSessionWithClipMetadata(
        editSession,
        readJson(editClipMetadataPath)
      )
      : editSession,
    recordingSession: recordingClipMetadataPath
      ? enrichSessionWithClipMetadata(
        recordingSession,
        readJson(recordingClipMetadataPath)
      )
      : recordingSession
  });

  const outputPath = path.resolve(argValue(args, "--output") || defaultOutputPath());
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(plan, null, 2));

  console.log(`Wrote dry-run conform plan: ${outputPath}`);
  console.log(JSON.stringify(plan.summary, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
