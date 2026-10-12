import { readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const PREFIX = "opencode-agents/";
const MAX_FILE = 64 * 1024 * 1024;
const MAX_TOTAL = 300 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function safeName(name) {
  if (!name.startsWith(PREFIX)) throw new Error(`ZIP entry lacks plugin prefix: ${name}`);
  const relative = name.slice(PREFIX.length);
  if (!relative || relative.includes("\\") || relative.includes("\0") ||
    relative.startsWith("/") || relative.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error(`unsafe ZIP entry path: ${name}`);
  return relative;
}

/** Fixed timestamp, permissions, ordering, flags, and compression settings. */
export function deterministicZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [relative, raw] of [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const name = PREFIX + relative;
    safeName(name);
    const filename = Buffer.from(name, "utf8");
    const bytes = Buffer.from(raw);
    if (bytes.length > MAX_FILE) throw new Error(`ZIP entry exceeds size limit: ${relative}`);
    const compressed = deflateRawSync(bytes, { level: 9 });
    const crc = crc32(bytes);
    if (offset > 0xffffffff || compressed.length > 0xffffffff || bytes.length > 0xffffffff)
      throw new Error("ZIP64 is not supported for plugin bundles");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12); // 1980-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4); // Unix, version 2.0
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0x21, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  if (entries.length > 0xffff || offset > 0xffffffff)
    throw new Error("ZIP64 is not supported for plugin bundles");
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

/** Extract only regular, bounded files with canonical names and matching CRCs. */
export function extractBundleZip(archivePath, destination) {
  if (statSync(archivePath).size > 350 * 1024 * 1024) throw new Error("ZIP archive exceeds size limit");
  const archive = readFileSync(archivePath);
  const end = archive.length - 22;
  if (end < 0 || archive.readUInt32LE(end) !== 0x06054b50 || archive.readUInt16LE(end + 20) !== 0 ||
    archive.readUInt16LE(end + 4) !== 0 || archive.readUInt16LE(end + 6) !== 0)
    throw new Error("unsupported ZIP end record");
  const count = archive.readUInt16LE(end + 10);
  if (count !== archive.readUInt16LE(end + 8)) throw new Error("split ZIP archive is not supported");
  const directorySize = archive.readUInt32LE(end + 12);
  const directoryOffset = archive.readUInt32LE(end + 16);
  if (directoryOffset + directorySize !== end) throw new Error("invalid ZIP directory bounds");
  let cursor = directoryOffset;
  let total = 0;
  const seen = new Set();
  const files = [];
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("invalid ZIP central entry");
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const disk = archive.readUInt16LE(cursor + 34);
    const mode = archive.readUInt32LE(cursor + 38) >>> 16;
    const localOffset = archive.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags !== 0x800 || method !== 8 || disk !== 0 || mode !== 0o100644 ||
      size > MAX_FILE || compressedSize > MAX_FILE || total + size > MAX_TOTAL)
      throw new Error("unsupported or oversized ZIP entry");
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const relative = safeName(name);
    if (seen.has(relative)) throw new Error(`duplicate ZIP entry: ${relative}`);
    seen.add(relative);
    if (localOffset + 30 > directoryOffset || archive.readUInt32LE(localOffset) !== 0x04034b50 ||
      archive.readUInt16LE(localOffset + 6) !== flags || archive.readUInt16LE(localOffset + 8) !== method ||
      archive.readUInt32LE(localOffset + 14) !== crc || archive.readUInt32LE(localOffset + 18) !== compressedSize ||
      archive.readUInt32LE(localOffset + 22) !== size)
      throw new Error(`ZIP local entry mismatch: ${relative}`);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > directoryOffset ||
      archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8") !== name)
      throw new Error(`ZIP local name or data bounds mismatch: ${relative}`);
    const bytes = inflateRawSync(archive.subarray(dataStart, dataStart + compressedSize),
      { maxOutputLength: size + 1 });
    if (bytes.length !== size || crc32(bytes) !== crc) throw new Error(`ZIP content mismatch: ${relative}`);
    files.push([relative, bytes]);
    total += size;
    cursor = next;
  }
  if (cursor !== end) throw new Error("unparsed ZIP directory bytes");
  for (const [relative, bytes] of files) {
    const output = join(destination, PREFIX, ...relative.split("/"));
    if (!output.startsWith(join(destination, "opencode-agents") + sep)) throw new Error("ZIP entry escaped destination");
    mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
    writeFileSync(output, bytes, { flag: "wx", mode: 0o644 });
  }
  return files.length;
}
