import zlib from "node:zlib";

export type ZipCaps = {
  /** Most bytes every entry may inflate to, together. */
  inflatedMax: number;
  /** Most entries the archive may hold. */
  entriesMax: number;
};

const END_OF_DIRECTORY = 0x06054b50;

// The end-of-central-directory record, searched back through the longest comment a zip allows.
function endOf(view: DataView, length: number): number {
  for (let at = length - 22; at >= Math.max(0, length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === END_OF_DIRECTORY) return at;
  }
  return -1;
}

/**
 * Whether the archive's own directory promises more than the caps allow, read before anything
 * inflates. A directory can lie; this stops the honest bomb, not a forged one. An archive whose
 * directory cannot be read is not judged big: `zipInflatesWithin` refuses it.
 */
export function zipTooBig(bytes: Uint8Array, caps: ZipCaps): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endOf(view, bytes.length);
  if (end < 0) return false;
  const entries = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (entries === 0xffff || at === 0xffffffff) return true;
  if (entries > caps.entriesMax) return true;
  let inflated = 0;
  for (let i = 0; i < entries; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return false;
    inflated += view.getUint32(at + 24, true);
    if (inflated > caps.inflatedMax) return true;
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return false;
}

/**
 * Whether the entries really inflate within the caps, measured by inflating each with an output
 * bound of what the total still allows. The directory's own sizes are not believed: it supplies only
 * where each entry sits and how many bytes it spans.
 */
export function zipInflatesWithin(bytes: Uint8Array, caps: ZipCaps): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endOf(view, bytes.length);
  if (end < 0) return false;
  const entries = view.getUint16(end + 10, true);
  let dir = view.getUint32(end + 16, true);
  if (entries === 0xffff || dir === 0xffffffff || entries > caps.entriesMax) return false;
  let remaining = caps.inflatedMax;
  for (let i = 0; i < entries; i++) {
    if (dir + 46 > bytes.length || view.getUint32(dir, true) !== 0x02014b50) return false;
    const span = view.getUint32(dir + 20, true);
    const local = view.getUint32(dir + 42, true);
    dir += 46 + view.getUint16(dir + 28, true) + view.getUint16(dir + 30, true) + view.getUint16(dir + 32, true);
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) return false;
    const method = view.getUint16(local + 8, true);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start > bytes.length) return false;
    const data = bytes.subarray(start, Math.min(bytes.length, start + span));
    if (method === 0) {
      if (data.length > remaining) return false;
      remaining -= data.length;
    } else if (method === 8) {
      try {
        remaining -= zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, remaining) }).length;
      } catch {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

/** Whether the archive is within both caps, by its directory and by what it inflates to. */
export function zipWithin(bytes: Uint8Array, caps: ZipCaps): boolean {
  return !zipTooBig(bytes, caps) && zipInflatesWithin(bytes, caps);
}
