import assert from "node:assert/strict";
import { test } from "node:test";

import { isInternalPath } from "./internal-path";

test("isInternalPath refuses every shape a browser reads as another origin", () => {
  for (const value of [
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    "/\u0000/evil",
    "/%09/evil",
    "/%0a/evil",
    "//evil.example",
    "/\\evil.example",
    "/%2F/evil",
    "/%5Cevil",
    "https://evil.example",
    "evil",
    "",
    "/",
    "/%E0%A4%A",
  ]) {
    assert.equal(isInternalPath(value), value === "/", JSON.stringify(value));
  }
});

test("isInternalPath keeps a same-origin path, query and fragment", () => {
  for (const value of ["/es", "/es/cuentas?mes=2026-10", "/es/a/b#c", "/es/ruta%20con%20espacio"]) {
    assert.equal(isInternalPath(value), true, value);
  }
});
