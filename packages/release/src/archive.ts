// A deterministic tar.gz writer and reader for release bundles (ADR 0160). Web APIs only.
//
// Determinism is what makes bundles reproducible: entries are sorted by path, every header has
// mode 0644, uid/gid 0, empty owner names and mtime 0, and the gzip header's mtime and OS bytes
// are fixed. Any `tar` can still list and extract the result (`tar -tzf crm-1.0.0.tar.gz`).

export interface ArchiveEntry {
  path: string;
  bytes: Uint8Array;
}

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeString(header: Uint8Array, offset: number, length: number, value: string) {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
  header.set(bytes, offset);
}

function writeOctal(header: Uint8Array, offset: number, length: number, value: number) {
  // length - 1 digits, then NUL.
  writeString(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarHeader(path: string, size: number): Uint8Array {
  if (encoder.encode(path).length > 100) throw new Error(`tar path over 100 bytes: ${path}`);
  const header = new Uint8Array(BLOCK);
  writeString(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156); // checksum field counts as spaces
  header[156] = 0x30; // '0': regular file
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  let sum = 0;
  for (const byte of header) sum += byte;
  writeString(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/** Writes an uncompressed tar of `entries`, sorted by path. Duplicate paths are an error. */
export function writeTar(entries: ArchiveEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let total = BLOCK * 2;
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i] as ArchiveEntry;
    if (i > 0 && sorted[i - 1]?.path === entry.path) throw new Error(`duplicate path ${entry.path}`);
    total += BLOCK + Math.ceil(entry.bytes.length / BLOCK) * BLOCK;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const entry of sorted) {
    out.set(tarHeader(entry.path, entry.bytes.length), offset);
    offset += BLOCK;
    out.set(entry.bytes, offset);
    offset += Math.ceil(entry.bytes.length / BLOCK) * BLOCK;
  }
  return out;
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const text = decoder.decode(block.subarray(offset, offset + length)).replace(/[\0 ]+$/g, "");
  return text ? Number.parseInt(text.trim(), 8) : 0;
}

/** Reads the regular files of a tar. Rejects absolute paths and `..` segments. */
export function readTar(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    let stored = 0;
    for (let i = 0; i < BLOCK; i++) stored += i >= 148 && i < 156 ? 0x20 : (header[i] as number);
    if (stored !== readOctal(header, 148, 8)) throw new Error("corrupt tar header checksum");
    const nameEnd = header.indexOf(0);
    const name = decoder.decode(header.subarray(0, nameEnd === -1 || nameEnd > 100 ? 100 : nameEnd));
    const prefixBytes = header.subarray(345, 500);
    const prefixEnd = prefixBytes.indexOf(0);
    const prefix = decoder.decode(prefixBytes.subarray(0, prefixEnd === -1 ? 155 : prefixEnd));
    const path = prefix ? `${prefix}/${name}` : name;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    offset += BLOCK;
    if (offset + size > bytes.length) throw new Error(`truncated tar entry ${path}`);
    if (type === "0" || type === "\0") {
      if (path.startsWith("/") || path.split("/").includes("..")) {
        throw new Error(`unsafe path in bundle: ${path}`);
      }
      if (files.has(path)) throw new Error(`duplicate path in bundle: ${path}`);
      files.set(path, bytes.slice(offset, offset + size));
    }
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

async function pipe(bytes: Uint8Array, transform: TransformStream<Uint8Array, Uint8Array>) {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Pins the gzip header's variable bytes: MTIME (4-7) to 0 and OS (9) to 255 ("unknown"), so the
 * output does not depend on when or on which platform it was compressed.
 */
export function normaliseGzipHeader(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error("not gzip data");
  const out = bytes.slice();
  out.fill(0, 4, 8);
  out[9] = 0xff;
  return out;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return normaliseGzipHeader(await pipe(bytes, new CompressionStream("gzip")));
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream("gzip"));
}
