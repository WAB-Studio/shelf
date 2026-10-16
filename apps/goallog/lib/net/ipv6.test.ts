import assert from "node:assert/strict";
import test from "node:test";

import { ipv6Bytes } from "./ipv6";

test("`::` expands to the missing zero groups wherever it sits", () => {
  assert.deepEqual(ipv6Bytes("::"), Array(16).fill(0));
  assert.deepEqual(ipv6Bytes("::1"), [...Array(15).fill(0), 1]);
  assert.deepEqual(ipv6Bytes("1::"), [0, 1, ...Array(14).fill(0)]);
  assert.deepEqual(ipv6Bytes("2001:db8::1:2"), [0x20, 0x01, 0x0d, 0xb8, ...Array(8).fill(0), 0, 1, 0, 2]);
});

test("a dotted v4 tail fills the last two groups", () => {
  assert.deepEqual(ipv6Bytes("::ffff:127.0.0.1"), [...Array(10).fill(0), 0xff, 0xff, 127, 0, 0, 1]);
  assert.equal(ipv6Bytes("::ffff:1.2.3.256"), null);
});

test("a zone id is dropped", () => {
  assert.deepEqual(ipv6Bytes("fe80::1%eth0"), ipv6Bytes("fe80::1"));
});

test("a literal that does not parse is null", () => {
  for (const bad of ["1::2::3", "1:2:3:4:5:6:7::8", "2001:db8::fffff", "1:2:3:4:5:6:7", "zz::1"]) {
    assert.equal(ipv6Bytes(bad), null, bad);
  }
});
