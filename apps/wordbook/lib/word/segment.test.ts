// Mutations: "remove the try" turns the malformed case red (it throws);
// "decode twice" turns the %2525 case red (it yields "%" and then a throw or
// a second decode).
import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeWordSegment } from "./segment";

test("a normal escape decodes", () => {
  assert.equal(decodeWordSegment("caf%C3%A9"), "café");
});

test("a malformed escape returns the raw segment and never throws", () => {
  for (const raw of ["100%zz", "100%", "%E0%A4%A"]) {
    assert.equal(decodeWordSegment(raw), raw);
  }
});

test("%2525 decodes exactly once", () => {
  assert.equal(decodeWordSegment("%2525"), "%25");
  assert.equal(decodeWordSegment("100%2525zz"), "100%25zz");
});
