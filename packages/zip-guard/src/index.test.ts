import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import test, { mock } from "node:test";
import zlib from "node:zlib";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { zipWithin } from "./index";

// M2: `zipWithin` answers whether an archive inflates to no more than `inflatedMax` bytes in
// at most `entriesMax` entries, judged by inflating, never by the directory's own claim.

const MIB = 1024 * 1024;
const CAPS = { inflatedMax: 64 * MIB, entriesMax: 200 };

async function zipOf(entries: Record<string, Buffer>, compression: "DEFLATE" | "STORE", base?: Uint8Array) {
  const zip = base ? await JSZip.loadAsync(base) : new JSZip();
  for (const [name, data] of Object.entries(entries)) zip.file(name, data, { compression });
  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression }));
}

// Overwrites the size a central-directory entry (and its local header) declares, and/or its method.
function forge(zip: Uint8Array, name: string, patch: { size?: number; method?: number }): Uint8Array {
  const out = Buffer.from(zip);
  const end = out.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entries = out.readUInt16LE(end + 10);
  let at = out.readUInt32LE(end + 16);
  let patched = 0;
  for (let i = 0; i < entries; i++) {
    const nameLength = out.readUInt16LE(at + 28);
    if (out.subarray(at + 46, at + 46 + nameLength).toString() === name) {
      const local = out.readUInt32LE(at + 42);
      if (patch.size !== undefined) {
        out.writeUInt32LE(patch.size, at + 24);
        out.writeUInt32LE(patch.size, local + 22);
      }
      if (patch.method !== undefined) {
        out.writeUInt16LE(patch.method, at + 10);
        out.writeUInt16LE(patch.method, local + 8);
      }
      patched++;
    }
    at += 46 + nameLength + out.readUInt16LE(at + 30) + out.readUInt16LE(at + 32);
  }
  assert.equal(patched, 1);
  return new Uint8Array(out);
}

async function workbook(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("One").addRow(["a", 1]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

test("a real workbook, deflated, is within the caps", async () => {
  assert.equal(zipWithin(await workbook(), CAPS), true);
});

test("a directory that claims 1 KB over an entry that inflates 80 MiB is refused", async () => {
  const bomb = forge(await zipOf({ "bomb.bin": Buffer.alloc(80 * MIB) }, "DEFLATE"), "bomb.bin", { size: 1024 });
  assert.equal(zipWithin(bomb, CAPS), false);
});

test("an honest directory over 80 MiB is refused too", async () => {
  assert.equal(zipWithin(await zipOf({ "bomb.bin": Buffer.alloc(80 * MIB) }, "DEFLATE"), CAPS), false);
});

test("the inflated cap is a parameter: the same archive passes a cap above its size and fails one below", async () => {
  const zip = await zipOf({ "a.bin": Buffer.alloc(2 * MIB) }, "DEFLATE");
  assert.equal(zipWithin(zip, { inflatedMax: 2 * MIB, entriesMax: 10 }), true);
  assert.equal(zipWithin(zip, { inflatedMax: 2 * MIB - 1, entriesMax: 10 }), false);
});

test("the cap counts every entry together", async () => {
  const two = await zipOf({ "a.bin": Buffer.alloc(40 * MIB), "b.bin": Buffer.alloc(40 * MIB) }, "DEFLATE");
  assert.equal(zipWithin(two, CAPS), false);
  const small = await zipOf({ "a.bin": Buffer.alloc(MIB), "b.bin": Buffer.alloc(MIB) }, "DEFLATE");
  assert.equal(zipWithin(small, { inflatedMax: 2 * MIB, entriesMax: 10 }), true);
  assert.equal(zipWithin(small, { inflatedMax: 2 * MIB - 1, entriesMax: 10 }), false);
});

test("stored entries count by their bytes", async () => {
  const zip = await zipOf({ "a.bin": Buffer.alloc(MIB, 7) }, "STORE");
  assert.equal(zipWithin(zip, { inflatedMax: MIB, entriesMax: 10 }), true);
  assert.equal(zipWithin(zip, { inflatedMax: MIB - 1, entriesMax: 10 }), false);
});

test("entries cap: 200 stored 1-byte entries are within it, 201 are not", async () => {
  const entries = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}.txt`, Buffer.from("x")]));
  assert.equal(zipWithin(await zipOf(entries(200), "STORE"), CAPS), true);
  assert.equal(zipWithin(await zipOf(entries(201), "STORE"), CAPS), false);
  assert.equal(zipWithin(await zipOf(entries(5), "STORE"), { inflatedMax: MIB, entriesMax: 4 }), false);
  assert.equal(zipWithin(await zipOf(entries(4), "STORE"), { inflatedMax: MIB, entriesMax: 4 }), true);
});

test("a compression method other than stored and deflate is refused", async () => {
  const zip = forge(await zipOf({ "a.bin": Buffer.alloc(10) }, "DEFLATE"), "a.bin", { method: 12 });
  assert.equal(zipWithin(zip, CAPS), false);
});

test("bytes that are not an archive, or are cut, are refused", async () => {
  assert.equal(zipWithin(new Uint8Array(0), CAPS), false);
  assert.equal(zipWithin(new TextEncoder().encode("not a zip at all, just text"), CAPS), false);
  const real = await workbook();
  assert.equal(zipWithin(real.subarray(0, real.length - 30), CAPS), false);
});

test("a zip64 marker in the directory is refused", async () => {
  const zip = Buffer.from(await zipOf({ "a.txt": Buffer.from("x") }, "STORE"));
  zip.writeUInt32LE(0xffffffff, zip.length - 22 + 16);
  assert.equal(zipWithin(new Uint8Array(zip), CAPS), false);
});

test("memory stays bounded: an entry inflating past the cap throws ERR_BUFFER_TOO_LARGE inside the guard and no inflate returns more than the cap", async () => {
  const returned: number[] = [];
  const thrown: string[] = [];
  const real = zlib.inflateRawSync;
  const spy = mock.method(zlib, "inflateRawSync", (...args: Parameters<typeof real>) => {
    try {
      const out = real(...args);
      returned.push(out.length);
      return out;
    } catch (error) {
      thrown.push((error as { code?: string }).code ?? String(error));
      throw error;
    }
  });
  syncBuiltinESMExports();
  try {
    const bomb = forge(await zipOf({ "bomb.bin": Buffer.alloc(80 * MIB) }, "DEFLATE"), "bomb.bin", { size: 1024 });
    assert.equal(zipWithin(bomb, CAPS), false);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(spy.mock.callCount() >= 1, "the guard inflated the entry");
  assert.deepEqual(thrown, ["ERR_BUFFER_TOO_LARGE"]);
  for (const length of returned) assert.ok(length <= CAPS.inflatedMax, `an inflate returned ${length} bytes`);
});
