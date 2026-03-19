import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const sourcePath = resolve("src-tauri/icons/icon.png");
const icoPath = resolve("src-tauri/icons/icon.ico");
const icnsPath = resolve("src-tauri/icons/icon.icns");

const png = readFileSync(sourcePath);
const PNG_SIGNATURE = "89504e470d0a1a0a";

function fail(message) {
  throw new Error(message);
}

function readPngDimension(buffer, offset) {
  return buffer.readUInt32BE(offset);
}

function assertSourcePng(buffer) {
  if (buffer.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
    fail(`Expected ${sourcePath} to be a PNG file.`);
  }

  const width = readPngDimension(buffer, 16);
  const height = readPngDimension(buffer, 20);

  if (width !== height) {
    fail(`Expected a square PNG icon, got ${width}x${height}.`);
  }

  if (width !== 256) {
    fail(
      `Expected ${sourcePath} to be 256x256 so it can be wrapped into .ico/.icns, got ${width}x${height}.`
    );
  }
}

function createIco(pngBuffer) {
  const header = Buffer.alloc(22);

  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(0, 6);
  header.writeUInt8(0, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(pngBuffer.length, 14);
  header.writeUInt32LE(header.length, 18);

  return Buffer.concat([header, pngBuffer]);
}

function createIcns(pngBuffer) {
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write("ic08", 0, 4, "ascii");
  chunkHeader.writeUInt32BE(8 + pngBuffer.length, 4);

  const fileHeader = Buffer.alloc(8);
  fileHeader.write("icns", 0, 4, "ascii");
  fileHeader.writeUInt32BE(fileHeader.length + chunkHeader.length + pngBuffer.length, 4);

  return Buffer.concat([fileHeader, chunkHeader, pngBuffer]);
}

assertSourcePng(png);

mkdirSync(dirname(icoPath), { recursive: true });
writeFileSync(icoPath, createIco(png));
writeFileSync(icnsPath, createIcns(png));

console.log(`Generated ${icoPath}`);
console.log(`Generated ${icnsPath}`);
