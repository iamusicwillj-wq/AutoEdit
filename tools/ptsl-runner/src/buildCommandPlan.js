#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildCommandPlan } from "./commandPlan.js";
import { reportsDir } from "./paths.js";

function usage() {
  console.log(`Usage:
  node src/buildCommandPlan.js --conform-plan <conform_plan.json> [--output <command_plan.json>]
`);
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? "" : args[index + 1] ?? "";
}

function defaultOutputPath() {
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return path.join(reportsDir, `command-plan-${runId}.json`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const conformPlanPath = argValue(args, "--conform-plan");
  if (!conformPlanPath) {
    usage();
    throw new Error("Missing --conform-plan");
  }

  const commandPlan = buildCommandPlan(JSON.parse(fs.readFileSync(path.resolve(conformPlanPath), "utf8")));
  const outputPath = path.resolve(argValue(args, "--output") || defaultOutputPath());
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(commandPlan, null, 2));
  console.log(`Wrote command plan: ${outputPath}`);
  console.log(JSON.stringify(commandPlan.summary, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
