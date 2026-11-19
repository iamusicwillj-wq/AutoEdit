import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export const runnerRoot = path.resolve(here, "..");
export const workspaceRoot = path.resolve(runnerRoot, "..", "..");
export const dataRoot = process.env.AUTOEDIT_DATA_ROOT
  ? path.resolve(process.env.AUTOEDIT_DATA_ROOT)
  : runnerRoot;
export const localSdkProtoPath = path.join(dataRoot, "SDK", "PTSL.proto");
export const protoPath = path.join(
  workspaceRoot,
  "third_party",
  "PTSL_SDK_CPP.2025.10.0.1267955",
  "Source",
  "PTSL.proto"
);
export const descriptorPath = path.join(runnerRoot, "PTSL.desc");
export const commandIdsPath = path.join(runnerRoot, "PTSL.command-ids.json");
export const phase0Root = path.join(dataRoot, "phase0");
export const phase0AssetsDir = path.join(phase0Root, "assets");
export const phase0ReportsDir = path.join(phase0Root, "reports");
export const exportsDir = path.join(dataRoot, "exports");
export const reportsDir = path.join(dataRoot, "reports");
export const sessionFilePath = path.join(dataRoot, ".ptsl-session.json");
