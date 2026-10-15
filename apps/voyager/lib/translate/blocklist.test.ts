// RL-64: a translation carrying a sexual or obscene term is never drawn.
import assert from "node:assert/strict";
import { test } from "node:test";

import { containsBlockedTerm } from "./blocklist";

test("the explicit sentence MyMemory returned for «i love you» is blocked", () => {
  assert.equal(containsBlockedTerm("Quiero que me la chupes hasta que me corra en tu boca."), true);
  assert.equal(containsBlockedTerm("Me encanta follar contigo."), true);
});

test("«te quiero» passes", () => {
  assert.equal(containsBlockedTerm("te quiero"), false);
});

test("matching is case- and accent-insensitive", () => {
  assert.equal(containsBlockedTerm("COÑO"), true);
  assert.equal(containsBlockedTerm("Fuck"), true);
  assert.equal(containsBlockedTerm("PUTA"), true);
});

test("matching is on word boundaries", () => {
  assert.equal(containsBlockedTerm("el peñón de Gibraltar"), false);
  assert.equal(containsBlockedTerm("Scunthorpe"), false);
  assert.equal(containsBlockedTerm("pendiente"), false);
  assert.equal(containsBlockedTerm("analista"), false);
  assert.equal(containsBlockedTerm("class assassin"), false);
});

test("neutral and clinical sentences pass", () => {
  assert.equal(containsBlockedTerm("Sexual harassment is a crime."), false);
  assert.equal(containsBlockedTerm("El acoso sexual es un delito."), false);
  assert.equal(containsBlockedTerm("La educación sexo-afectiva y la anatomía del pene."), false);
  assert.equal(containsBlockedTerm("The victim of rape testified."), false);
});
