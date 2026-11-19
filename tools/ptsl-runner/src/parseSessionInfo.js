#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseSessionInfoFile } from "./sessionInfoParser.js";

function usage() {
  console.log(`Usage:
  npm run parse-session-info -- --input <session_info.txt> [--output <parsed.json>]
`);
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? "" : args[index + 1] ?? "";
}

function printSummary(parsed) {
  const audioEventCount = parsed.tracks.reduce(
    (sum, track) => sum + track.events.filter((event) => !event.isFade).length,
    0
  );
  console.log(JSON.stringify({
    sessionName: parsed.metadata.sessionName,
    sampleRate: parsed.metadata.sampleRate,
    onlineFiles: parsed.onlineFiles.length,
    onlineClips: parsed.onlineClips.length,
    tracks: parsed.tracks.length,
    trackEvents: parsed.tracks.reduce((sum, track) => sum + track.events.length, 0),
    audioEvents: audioEventCount,
    markers: parsed.markers.length,
    warnings: parsed.warnings.length
  }, null, 2));
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const input = argValue(args, "--input");
  if (!input) {
    usage();
    throw new Error("Missing --input");
  }

  const parsed = parseSessionInfoFile(path.resolve(input));
  const output = argValue(args, "--output");
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(path.resolve(output), JSON.stringify(parsed, null, 2));
    console.log(`Wrote parsed session info: ${path.resolve(output)}`);
  }
  printSummary(parsed);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
