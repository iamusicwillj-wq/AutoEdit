import fs from "node:fs";
import path from "node:path";
import { phase0AssetsDir } from "./paths.js";

const sampleRate = 48000;
const bitDepth = 16;

function writeAscii(buffer, offset, value) {
  buffer.write(value, offset, value.length, "ascii");
}

function makeWav({ filePath, channels, seconds, tones }) {
  const frames = Math.floor(sampleRate * seconds);
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  writeAscii(buffer, 0, "RIFF");
  buffer.writeUInt32LE(36 + dataSize, 4);
  writeAscii(buffer, 8, "WAVE");
  writeAscii(buffer, 12, "fmt ");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  writeAscii(buffer, 36, "data");
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.min(1, i / 800, (frames - i) / 800);
    for (let ch = 0; ch < channels; ch += 1) {
      const freq = tones[ch] ?? tones[0];
      const value = Math.round(Math.sin(2 * Math.PI * freq * t) * 0.25 * 32767 * envelope);
      buffer.writeInt16LE(value, offset);
      offset += 2;
    }
  }

  fs.writeFileSync(filePath, buffer);
}

fs.mkdirSync(phase0AssetsDir, { recursive: true });

const assets = [
  { name: "phase0_mono_take_a.wav", channels: 1, seconds: 12, tones: [440] },
  { name: "phase0_mono_take_b.wav", channels: 1, seconds: 12, tones: [660] },
  { name: "phase0_stereo_take.wav", channels: 2, seconds: 12, tones: [330, 550] }
];

for (const asset of assets) {
  const filePath = path.join(phase0AssetsDir, asset.name);
  makeWav({ filePath, ...asset });
  console.log(filePath);
}
