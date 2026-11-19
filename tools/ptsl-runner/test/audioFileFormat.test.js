import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectAudioFile } from "../src/audioFileFormat.js";

function writeWave(filePath, { sampleRate, bitDepth, float = false }) {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(float ? 3 : 1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2 * (bitDepth / 8), 28);
  buffer.writeUInt16LE(2 * (bitDepth / 8), 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(0, 40);
  fs.writeFileSync(filePath, buffer);
}

function writeAiff(filePath) {
  const buffer = Buffer.alloc(38);
  buffer.write("FORM", 0, "ascii");
  buffer.writeUInt32BE(30, 4);
  buffer.write("AIFFCOMM", 8, "ascii");
  buffer.writeUInt32BE(18, 16);
  buffer.writeUInt16BE(2, 20);
  buffer.writeUInt32BE(0, 22);
  buffer.writeUInt16BE(24, 26);
  Buffer.from("400ebb80000000000000", "hex").copy(buffer, 28);
  fs.writeFileSync(filePath, buffer);
}

test("inspectAudioFile reads integer WAVE format", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoedit-format-test-"));
  const filePath = path.join(root, "source.wav");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeWave(filePath, { sampleRate: 48000, bitDepth: 24 });

  assert.deepEqual(inspectAudioFile(filePath), {
    fileType: "WAVE",
    channelCount: 2,
    sampleRate: 48000,
    bitDepth: 24,
    sampleEncoding: "integer"
  });
});

test("inspectAudioFile distinguishes 32-bit float WAVE", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoedit-format-test-"));
  const filePath = path.join(root, "source.wav");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeWave(filePath, { sampleRate: 96000, bitDepth: 32, float: true });

  assert.deepEqual(inspectAudioFile(filePath), {
    fileType: "WAVE",
    channelCount: 2,
    sampleRate: 96000,
    bitDepth: 32,
    sampleEncoding: "float"
  });
});

test("inspectAudioFile reads integer AIFF format", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoedit-format-test-"));
  const filePath = path.join(root, "source.aiff");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeAiff(filePath);

  assert.deepEqual(inspectAudioFile(filePath), {
    fileType: "AIFF",
    channelCount: 2,
    sampleRate: 48000,
    bitDepth: 24,
    sampleEncoding: "integer"
  });
});
