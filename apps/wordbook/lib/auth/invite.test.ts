import assert from "node:assert/strict";
import test from "node:test";

import { normaliseInvite } from "./invite";

// RL-69: the list stores one shape, and the script that fills it and the check that reads it agree on it.
// The column's CHECK demands lowercase, trimmed, with an `@` after the first character.
test("an address typed with capitals and spaces around it is stored lowercase and trimmed", () => {
  assert.equal(normaliseInvite(" Ana@X.co "), "ana@x.co");
  assert.equal(normaliseInvite("ANA@X.CO\n"), "ana@x.co");
});

test("an address already in the stored shape comes back unchanged", () => {
  assert.equal(normaliseInvite("ana@x.co"), "ana@x.co");
});

test("a string that is not an address is null", () => {
  for (const raw of ["x", "", "   ", "@x.co", "ana@", "ana@x", "a b@x.co", "ana@@x.co"]) {
    assert.equal(normaliseInvite(raw), null, JSON.stringify(raw));
  }
});

test("normalising twice changes nothing", () => {
  const once = normaliseInvite("  MiXed@Case.Co ");
  assert.ok(once);
  assert.equal(normaliseInvite(once), once);
});
