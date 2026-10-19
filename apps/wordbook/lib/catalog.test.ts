import assert from "node:assert/strict";
import { test } from "node:test";

import { createTranslator } from "next-intl";

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
  assert.deepEqual(
    all.filter(([, text]) => /cierres esta pestaña/.test(text)),
    [],
  );
});

test("the signed-in link-refused body exists, quotes «» only and points at no form below", () => {
  const body = messages.account.errors.linkOtherBrowserSignedInBody;
  assert.equal(
    body,
    "Por seguridad el enlace solo entra en el navegador que lo pidió. Aquí ya tienes la sesión abierta; si querías entrar en otro navegador, abre el enlace allí.",
  );
  assert.doesNotMatch(body, /aquí abajo/);
});

// The words of the boards RegistroPendiente, PalabraPendiente and CopiaAnkiPendiente
// (docs/wordbook/DESIGN.md, boards of 2026-10-18), character for character. The key
// names are the worker's; the catalog must hold each sentence under some key.
const PENDING_STRINGS = [
  "Sin respuesta todavía",
  "Se responde sola cuando vuelva la conexión.",
  "Se traduce sola cuando vuelva la conexión.",
  "Esta búsqueda espera respuesta",
  "No había conexión cuando la buscaste. Se responde sola cuando vuelva, y su traducción aparece aquí.",
  "Búsquedas",
];

for (const sentence of PENDING_STRINGS) {
  test(`the catalog holds the pending board's line «${sentence}»`, () => {
    assert.ok(
      strings(messages).some(([, text]) => text === sentence),
      `no string equals ${sentence}`,
    );
  });
}

test("the pending lines sit under the log screens, not under search or account", () => {
  const where = (sentence: string) =>
    strings(messages)
      .filter(([, text]) => text === sentence)
      .map(([path]) => path);
  for (const sentence of PENDING_STRINGS.slice(0, 5)) {
    assert.ok(
      where(sentence).length > 0 && where(sentence).every((path) => path.startsWith("log.")),
      `${sentence} lives at ${where(sentence).join(", ")}`,
    );
  }
});

test("the Anki pending line pluralises as the board writes it: one waits, three wait", () => {
  const entry = strings(messages).find(
    ([, text]) => text.includes("espera respuesta: entra en Anki cuando la tenga") && text.includes("plural"),
  );
  assert.ok(entry, "no plural string carries the board's Anki pending line");
  const [path] = entry;
  const t = createTranslator({ locale: "es", messages });
  // The argument's name is the worker's: every plausible one is passed.
  const say = (n: number) => {
    const values = { count: n, pending: n, words: n, waiting: n, cards: n, number: n };
    return (t as unknown as (key: string, values: Record<string, number>) => string)(path, values);
  };
  assert.equal(say(1), "1 palabra espera respuesta: entra en Anki cuando la tenga.");
  assert.equal(say(3), "3 palabras esperan respuesta: entran en Anki cuando la tengan.");
  assert.notEqual(path, "log.study.ankiSkipped");
});

test("the left-out line stays as it was, apart from the pending line", () => {
  assert.equal(
    messages.log.study.ankiSkipped,
    "{count, plural, one {# palabra no va: no tiene traducción guardada. Si la buscaste hace tiempo, búscala otra vez y tendrá tarjeta.} other {# palabras no van: no tienen traducción guardada. Si las buscaste hace tiempo, búscalas otra vez y tendrán tarjeta.}}",
  );
  assert.doesNotMatch(messages.log.study.ankiSkipped, /espera/);
});
