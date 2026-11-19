#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PtslClient, loadSavedSessionId } from "./ptslClient.js";
import { SessionReader, exportSession } from "./sessionReadWorkflow.js";
import { parseSessionInfoFile } from "./sessionInfoParser.js";
import { reportsDir } from "./paths.js";

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const mode = args[0];
let reader;
let staging;
let diagnosticPath;
try {
  if (!["snapshot", "selected", "export"].includes(mode)) throw new Error("Expected snapshot, selected, or export.");
  fs.mkdirSync(reportsDir, { recursive: true });
  diagnosticPath = path.join(reportsDir, `session-read-${Date.now()}-${crypto.randomUUID()}.json`);
  reader = new SessionReader(new PtslClient({ sessionId: loadSavedSessionId() }));
  let body;
  if (mode === "snapshot") body = await reader.snapshot();
  if (mode === "selected") body = await reader.selectedTracks();
  if (mode === "export") {
    const paths = {};
    for (const key of ["info", "metadata", "parsed"]) {
      if (!args.includes(`--${key}`) || !value(`--${key}`)) throw new Error(`Missing --${key}`);
      paths[key] = path.resolve(value(`--${key}`));
      fs.mkdirSync(path.dirname(paths[key]), { recursive: true });
    }
    staging = fs.mkdtempSync(path.join(path.dirname(paths.info), ".session-export-"));
    const staged = Object.fromEntries(Object.keys(paths).map(key => [key, path.join(staging, key === "info" ? "info.txt" : `${key}.json`)]));
    body = await exportSession(reader, staged, parseSessionInfoFile);
    for (const key of Object.keys(paths)) fs.copyFileSync(staged[key], paths[key]);
  }
  console.log(JSON.stringify({ body, diagnostics_path: diagnosticPath }));
} catch (error) {
  console.error(`Error: ${error.message}`);
  if (diagnosticPath) console.error(`Diagnostics: ${diagnosticPath}`);
  process.exitCode = 1;
} finally {
  if (reader) {
    reader.client.close();
    fs.writeFileSync(diagnosticPath, JSON.stringify({ mode, responses: reader.responses }, null, 2));
  }
  if (staging) fs.rmSync(staging, { recursive: true, force: true });
}
