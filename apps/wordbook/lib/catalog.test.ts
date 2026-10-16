import assert from "node:assert/strict";
import { test } from "node:test";

import messages from "../messages/es.json";

function strings(node: unknown, path = ""): Array<[string, string]> {
  if (typeof node === "string") return [[path, node]];
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) => strings(value, path ? `${path}.${key}` : key));
  }
  return [];
}

test("the catalog quotes with «» only: no straight double quote in any string", () => {
  const offenders = strings(messages).filter(([, text]) => text.includes('"'));
  assert.deepEqual(offenders, []);
});

test("the offer and formOf read «surface» … «lemma»", () => {
  assert.equal(messages.word.viaInflectionWithEntry, "«{surface}» también es una forma de «{lemma}»");
  assert.equal(messages.word.formOf, "«{surface}» es una forma de «{lemma}»");
});

test("the dead licence credit key is gone; the screen's own two stay", () => {
  assert.equal("licenceCredit" in messages.account.info, false);
  assert.ok(messages.account.info.licenceBody);
  assert.ok(messages.account.info.licenceName);
});

test("the quota line names the hour and the words stay; no «Mañana»", () => {
  const body = messages.account.copy.failedQuotaBody;
  assert.match(body, /Sigue sola a las \{\w+\}; tus palabras siguen en este dispositivo\.$/);
  assert.doesNotMatch(body, /Mañana/);
});

test("the first-copy line is the board's and nothing promises a closed tab", () => {
  const all = strings(messages);
  assert.ok(all.some(([, text]) => text === "Aún no ha habido una copia."));
  assert.deepEqual(all.filter(([, text]) => /cierres esta pestaña/.test(text)), []);
});
