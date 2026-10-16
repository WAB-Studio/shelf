import assert from "node:assert/strict";
import { test } from "node:test";

import { fingerprintMessage } from "./fingerprint";

test("the same shape with another amount and date shares a shapeHash", () => {
  const a = fingerprintMessage("Compraste $12.500 en BOLD CO ONLINE el 24/08/26 a las 18:31");
  const b = fingerprintMessage("Compraste $99.000 en BOLD CO ONLINE el 03/09/26 a las 09:05");

  assert.equal(a.shapeHash, b.shapeHash);
  assert.notEqual(a.contentHash, b.contentHash);
});

test("another merchant shape gives another shapeHash", () => {
  const a = fingerprintMessage("Compraste $12.500 en BOLD CO ONLINE");
  const b = fingerprintMessage("Transferiste $12.500 a CARLOS NIETO");

  assert.notEqual(a.shapeHash, b.shapeHash);
});

test("the merchant is read after an anchor word", () => {
  const { merchant } = fingerprintMessage("Compraste $12.500 en BOLD CO ONLINE.");

  assert.deepEqual(merchant, { key: "BOLD CO ONLINE", label: "BOLD CO ONLINE" });
});

test("a message with no counterparty yields no merchant", () => {
  assert.equal(fingerprintMessage("Pago recibido 12345").merchant, null);
});
