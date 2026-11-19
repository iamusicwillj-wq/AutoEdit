import fs from "node:fs";

function readExtended80(buffer, offset) {
  const exponent = buffer.readUInt16BE(offset);
  const high = buffer.readUInt32BE(offset + 2);
  const low = buffer.readUInt32BE(offset + 6);
  if (exponent === 0 && high === 0 && low === 0) {
    return 0;
  }
  const sign = exponent & 0x8000 ? -1 : 1;
  const power = (exponent & 0x7fff) - 16383;
  const mantissa = high * 2 ** -31 + low * 2 ** -63;
  return Math.round(sign * mantissa * 2 ** power);
}

function parseWave(buffer) {
  if (buffer.length < 12 || !["RIFF", "RF64", "BW64"].includes(buffer.toString("ascii", 0, 4))
      || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (chunkId === "fmt " && dataOffset + Math.min(chunkSize, 40) <= buffer.length && chunkSize >= 16) {
      let encoding = buffer.readUInt16LE(dataOffset);
      const bitsPerSample = buffer.readUInt16LE(dataOffset + 14);
      if (encoding === 0xfffe && chunkSize >= 40) {
        encoding = buffer.readUInt16LE(dataOffset + 24);
      }
      return {
        fileType: "WAVE",
        channelCount: buffer.readUInt16LE(dataOffset + 2),
        sampleRate: buffer.readUInt32LE(dataOffset + 4),
        bitDepth: bitsPerSample,
        sampleEncoding: encoding === 3 ? "float" : encoding === 1 ? "integer" : "unknown"
      };
    }
    if (chunkSize === 0xffffffff) {
      break;
    }
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }
  return null;
}

function parseAiff(buffer) {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "FORM") {
    return null;
  }
  const formType = buffer.toString("ascii", 8, 12);
  if (!["AIFF", "AIFC"].includes(formType)) {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32BE(offset + 4);
    const dataOffset = offset + 8;
    if (chunkId === "COMM" && chunkSize >= 18 && dataOffset + chunkSize <= buffer.length) {
      const compression = formType === "AIFC" && chunkSize >= 22
        ? buffer.toString("ascii", dataOffset + 18, dataOffset + 22)
        : "NONE";
      return {
        fileType: "AIFF",
        channelCount: buffer.readUInt16BE(dataOffset),
        sampleRate: readExtended80(buffer, dataOffset + 8),
        bitDepth: buffer.readUInt16BE(dataOffset + 6),
        sampleEncoding: ["fl32", "FL32", "fl64", "FL64"].includes(compression)
          ? "float"
          : ["NONE", "twos", "sowt"].includes(compression) ? "integer" : "unknown"
      };
    }
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }
  return null;
}

export function inspectAudioFile(filePath) {
  const file = fs.openSync(filePath, "r");
  try {
    const size = Math.min(fs.fstatSync(file).size, 1024 * 1024);
    const buffer = Buffer.alloc(size);
    fs.readSync(file, buffer, 0, size, 0);
    return parseWave(buffer) ?? parseAiff(buffer);
  } finally {
    fs.closeSync(file);
  }
}
