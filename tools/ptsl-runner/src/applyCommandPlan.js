#!/usr/bin/env node
import { verifyPlanApproval } from "./executionPolicy.js";
import fs from "node:fs";
import { partialPreflight } from "./partialPlan.js";
import { executePartialPlan } from "./partialApply.js";
import { runtimeApproval } from "./runtimeApproval.js";
import { createApplyReportWriter } from "./applyReportWriter.js";
import path from "node:path";
import {
  CommandPlanExecutionError,
  executeCommandPlan,
  preflightCommandPlan,
  verifyExpectedSession
} from "./applyEngine.js";
import { PtslClient, loadSavedSessionId } from "./ptslClient.js";
import { reportsDir } from "./paths.js";

function usage() {
  console.log(`Usage:
  npm run apply-plan -- --command-plan <command_plan.json> [--execute] [--expected-session <name>] [--audio-operation {AOperations_AddAudio|AOperations_ConvertAudio}] [--allow-warnings] [--automatic-policy] [--partial-policy] [--uncertain-audio {skip|import}] [--approved-policy-sha256 <digest>] [--approval-directory <directory>] [--run-id <id>] [--inspect] [--approved-plan-sha256 <digest>] [--report <report.json>]

Without --execute this only runs preflight and writes no Pro Tools changes.
With --execute, --expected-session is required as a write safety check.
`);
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? "" : args[index + 1] ?? "";
}

function defaultReportPath() {
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return path.join(reportsDir, `apply-plan-${runId}.json`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const commandPlanPath = argValue(args, "--command-plan");
  if (!commandPlanPath) {
    usage();
    throw new Error("Missing --command-plan");
  }

  const planBytes = fs.readFileSync(path.resolve(commandPlanPath));
  const commandPlan = JSON.parse(planBytes);
  const partialPolicy = args.includes("--partial-policy");
  const uncertainAudio = argValue(args,"--uncertain-audio") || 'skip';
  const approvedPolicyDigest = argValue(args,"--approved-policy-sha256");
  const automaticPolicy = args.includes("--automatic-policy");
  const approvePositionWarnings = verifyPlanApproval(planBytes, argValue(args, "--approved-plan-sha256"));
  const allowWarnings = args.includes("--allow-warnings");
  const execute = args.includes("--execute");
  const expectedSession = argValue(args, "--expected-session");
  const audioOperation = argValue(args, "--audio-operation") || "AOperations_AddAudio";
  const supportedAudioOperations = new Set([
    "AOperations_AddAudio",
    "AOperations_ConvertAudio"
  ]);
  if (!supportedAudioOperations.has(audioOperation)) {
    throw new Error(`Unsupported --audio-operation: ${audioOperation}`);
  }
  const reportPath = path.resolve(argValue(args, "--report") || defaultReportPath());
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  if (!execute) {
    const preflight = partialPolicy ? partialPreflight(commandPlan,{approvedPolicyDigest,uncertainAudio,includeAlternatives:true}) : preflightCommandPlan(commandPlan, { allowWarnings, automaticPolicy, approvePositionWarnings });
    fs.writeFileSync(reportPath, JSON.stringify({ execute: false, preflight }, null, 2));
    console.log(`Wrote preflight report: ${reportPath}`);
    console.log(JSON.stringify(preflight.summary, null, 2));
    if (!preflight.okToExecute) {
      console.error(`Preflight blocked: ${preflight.blockers.map((issue) => issue.message).join("; ")}`);
      if (!args.includes("--inspect")) process.exitCode = 2;
    }
    return;
  }

  if (!expectedSession) {
    throw new Error("Missing --expected-session for --execute");
  }

  const client = new PtslClient({ sessionId: loadSavedSessionId() });
  let writer;
  try {
    if (!client.sessionId) {
      await client.register({
        companyName: "Auto Edit",
        applicationName: "PTSL Music Conformer Apply"
      });
    }
    const sessionCheck = await verifyExpectedSession(client, expectedSession);
    if (partialPolicy) writer = createApplyReportWriter(reportPath, {sessionCheck});
    const result = partialPolicy ? await executePartialPlan(commandPlan,client,{
      expectedSession, approvedPolicyDigest, audioOperation, uncertainAudio,
      onIssue:runtimeApproval(argValue(args,"--approval-directory"),argValue(args,"--run-id")),
      isPlanCurrent:()=>fs.readFileSync(path.resolve(commandPlanPath)).equals(planBytes),
      checkpoint:report=>writer.checkpoint(report)
    }) : await executeCommandPlan(commandPlan, client, {
      allowWarnings,
      automaticPolicy,
      approvePositionWarnings,
      audioOperation
    });
    if (writer) writer.finish({execute:true, ...result});
    else fs.writeFileSync(reportPath, JSON.stringify({ execute: true, sessionCheck, ...result }, null, 2));
    console.log(`Wrote apply report: ${reportPath}`);
    const importBatches = Object.fromEntries(
      (result.importStrategy?.batches ?? []).map((batch) => [batch.operation, batch.fileCount])
    );
    console.log(JSON.stringify({
      failedCommands: result.failedCommands,
      createdClipGroups: Object.keys(result.createdClipIdsByName).length,
      ...(result.importStrategy ? {
        smartImport: {
          add: importBatches.AOperations_AddAudio ?? 0,
          copy: importBatches.AOperations_CopyAudio ?? 0,
          convert: importBatches.AOperations_ConvertAudio ?? 0
        }
      } : {})
    }, null, 2));
    if (result.failedCommands && !partialPolicy) {
      process.exitCode = 2;
    }
  } catch (error) {
    if (writer) {
      writer.finish({execute:true, ok:false, error:error.message, ...(error.partialResult ?? {})});
      error.reportWritten = true;
    }
    throw error;
  } finally {
    client.close();
  }
}

main().catch((error) => {
  const reportPath = path.resolve(argValue(process.argv.slice(2), "--report") || defaultReportPath());
  if (error instanceof CommandPlanExecutionError && !error.reportWritten) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({
      execute: true,
      ok: false,
      error: error.message,
      ...error.partialResult
    }, null, 2));
    console.error(`Wrote failed apply report: ${reportPath}`);
  }
  console.error(error.stack || error.message);
  process.exit(1);
});
