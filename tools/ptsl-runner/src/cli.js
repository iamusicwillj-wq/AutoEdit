#!/usr/bin/env node
import { PtslClient, loadSavedSessionId, parseCliJson, isFailure } from "./ptslClient.js";

function usage() {
  console.log(`Usage:
  npm run ptsl -- register
  npm run ptsl -- send <CommandName> [--json '{"field":"value"}'] [--no-session]

Examples:
  npm run ptsl -- register
  npm run ptsl -- send HostReadyCheck
  npm run ptsl -- send GetSessionSampleRate
`);
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return "";
  }
  return args[index + 1] ?? "";
}

async function main() {
  const args = process.argv.slice(2);
  const action = args[0];
  if (!action || action === "--help" || action === "-h") {
    usage();
    return;
  }

  const client = new PtslClient({
    sessionId: args.includes("--no-session") ? "" : loadSavedSessionId()
  });

  try {
    let response;
    if (action === "register") {
      response = await client.register();
    } else if (action === "send") {
      const commandName = args[1];
      if (!commandName) {
        throw new Error("Missing command name");
      }
      const body = parseCliJson(argValue(args, "--json"), "--json");
      response = await client.send(commandName, body);
    } else {
      throw new Error(`Unknown action: ${action}`);
    }

    console.log(JSON.stringify(response, null, 2));
    if (isFailure(response)) {
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
