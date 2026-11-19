import { PtslClient, isFailure } from "./ptslClient.js";

async function main() {
  const client = new PtslClient();
  const results = [];
  try {
    results.push(await client.register());
    for (const commandName of [
      "HostReadyCheck",
      "GetPTSLVersion",
      "GetSessionName",
      "GetSessionSampleRate",
      "GetSessionTimeCodeRate"
    ]) {
      results.push(await client.send(commandName));
    }
  } finally {
    client.close();
  }

  console.log(JSON.stringify(results, null, 2));
  if (results.some(isFailure)) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
