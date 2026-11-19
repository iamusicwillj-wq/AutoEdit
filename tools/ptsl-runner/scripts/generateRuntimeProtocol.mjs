import fs from "node:fs";
import path from "node:path";
import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor/index.js";

function usage() {
  console.error("Usage: node scripts/generateRuntimeProtocol.mjs <PTSL.proto> <output-directory>");
}

const [, , sourcePath, outputDirectory] = process.argv;
if (!sourcePath || !outputDirectory) {
  usage();
  process.exit(1);
}

const source = fs.readFileSync(sourcePath, "utf8");
const root = protobuf.loadSync(sourcePath).resolveAll();
const descriptorSet = root.toDescriptor("proto3");
const descriptorBuffer = descriptor.FileDescriptorSet.encode(descriptorSet).finish();

const commandIds = {};
const commandRegex = /^\s*(CId_)?([A-Za-z][A-Za-z0-9_]*)\s*=\s*(\d+)\s*;/gm;
let match;
while ((match = commandRegex.exec(source))) {
  const fullName = `${match[1] ?? ""}${match[2]}`;
  const baseName = match[2];
  const value = Number(match[3]);
  commandIds[fullName] = value;
  if (match[1] === "CId_") {
    commandIds[baseName] = value;
  }
}

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, "PTSL.desc"), descriptorBuffer);
fs.writeFileSync(
  path.join(outputDirectory, "PTSL.command-ids.json"),
  `${JSON.stringify(commandIds, null, 2)}\n`
);

console.log(`Generated runtime PTSL protocol (${descriptorBuffer.length} bytes)`);
