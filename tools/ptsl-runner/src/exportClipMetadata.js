#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { PtslClient, loadSavedSessionId, isFailure } from "./ptslClient.js";
import { exportsDir } from "./paths.js";

function usage() {
  console.log(`Usage:
  npm run export-clip-metadata -- [--output <clip_metadata.json>] [--limit 500]

This is read-only: it calls GetClipList and GetFileLocation.
`);
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? "" : args[index + 1] ?? "";
}

function defaultOutputPath() {
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return path.join(exportsDir, `clip_metadata_${runId}.json`);
}

function pageInfo(response) {
  const page = response.body.pagination_response ?? response.body.stats ?? {};
  return {
    limit: Number(page.limit ?? 0),
    offset: Number(page.offset ?? 0)
  };
}

function firstList(body, listKeys) {
  for (const key of listKeys) {
    if (Array.isArray(body[key])) {
      return body[key];
    }
  }
  return [];
}

async function fetchPaged(client, commandName, listKeys, bodyFactory, limit) {
  const items = [];
  const responses = [];
  let offset = 0;

  while (true) {
    const response = await client.send(commandName, bodyFactory({ limit, offset }));
    responses.push(response);
    const pageItems = firstList(response.body, listKeys);
    items.push(...pageItems);

    const page = pageInfo(response);
    if (isFailure(response) || pageItems.length === 0 || pageItems.length < limit) {
      break;
    }
    offset += page.limit || limit;
  }

  return { items, responses };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const limit = Number(argValue(args, "--limit") || 500);
  const outputPath = path.resolve(argValue(args, "--output") || defaultOutputPath());
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const client = new PtslClient({ sessionId: loadSavedSessionId() });
  const allResponses = [];

  try {
    if (!client.sessionId) {
      allResponses.push(await client.register({
        companyName: "Auto Edit",
        applicationName: "PTSL Music Conformer"
      }));
    }

    const clipList = await fetchPaged(
      client,
      "GetClipList",
      ["clips", "clip_list"],
      ({ limit: pageLimit, offset }) => ({
        pagination_request: { limit: pageLimit, offset }
      }),
      limit
    );
    allResponses.push(...clipList.responses);

    const fileLocations = await fetchPaged(
      client,
      "GetFileLocation",
      ["file_locations", "fileLocations"],
      ({ limit: pageLimit, offset }) => ({
        file_filters: ["FLTFilter_AllFiles"],
        pagination_request: { limit: pageLimit, offset }
      }),
      limit
    );
    allResponses.push(...fileLocations.responses);

    const output = {
      exported_at: new Date().toISOString(),
      clips: clipList.items,
      file_locations: fileLocations.items
    };
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`Exported clip metadata: ${outputPath}`);
    console.log(JSON.stringify({
      clips: output.clips.length,
      fileLocations: output.file_locations.length
    }, null, 2));

    if (allResponses.some(isFailure)) {
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
