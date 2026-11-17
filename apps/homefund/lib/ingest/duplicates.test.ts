import assert from "node:assert/strict";
import { test } from "node:test";

import { judgeDuplicate, type DuplicateCandidate, type DuplicateFacts } from "./duplicates";

const NOW = Date.parse("2026-11-11T22:00:00-05:00");
const MINUTE = 60_000;

function candidate(overrides: Partial<DuplicateCandidate> & { id: string }): DuplicateCandidate {
  return {
    fromEmail: false,
    rawText: "",
    occurredOn: "2026-11-11",
    receivedAt: NOW,
    status: "pending",
    receipt: false,
    shapeHash: "a".repeat(64),
    direction: "expense",
    merchantKey: null,
    merchantLabel: null,
    ...overrides,
  };
}

const base = { fromEmail: true, text: "", occurredOn: "2026-11-11", receivedAt: NOW, direction: "expense" as const };
const receipt: DuplicateFacts = { ...base, receipt: true, shapeHash: "b".repeat(64) };
const alert: DuplicateFacts = { ...base, receipt: false, shapeHash: "c".repeat(64) };

test("a receipt repeats the pending or accepted alert of the same payment", () => {
  assert.deepEqual(judgeDuplicate(receipt, [candidate({ id: "alert" })]), {
    kind: "repeats",
    of: candidate({ id: "alert" }),
  });
  const accepted = candidate({ id: "done", status: "accepted" });
  const waiting = candidate({ id: "waiting" });
  const verdict = judgeDuplicate(receipt, [waiting, accepted]);
  assert.equal(verdict.kind, "repeats");
  assert.equal(verdict.kind === "repeats" && verdict.of.id, "done");
});

test("a receipt with no alert stays pending, unless a receipt of another template reports the payment", () => {
  assert.deepEqual(judgeDuplicate(receipt, []), { kind: "none" });
  assert.deepEqual(judgeDuplicate(receipt, [candidate({ id: "same", receipt: true, shapeHash: receipt.shapeHash })]), {
    kind: "none",
  });
  const verdict = judgeDuplicate(receipt, [candidate({ id: "gateway", receipt: true })]);
  assert.equal(verdict.kind === "repeats" && verdict.of.id, "gateway");
});

test("an alert replaces the receipts still waiting and never repeats another alert", () => {
  assert.deepEqual(judgeDuplicate(alert, [candidate({ id: "other-alert", fromEmail: true })]), { kind: "none" });
  const verdict = judgeDuplicate(alert, [
    candidate({ id: "r1", receipt: true }),
    candidate({ id: "r2", receipt: true }),
    candidate({ id: "alert", fromEmail: true }),
  ]);
  assert.equal(verdict.kind, "supersedes");
  assert.deepEqual(verdict.kind === "supersedes" && verdict.pending.map((row) => row.id), ["r1", "r2"]);
});

test("an alert that arrives after its receipt was accepted is the repeat", () => {
  const verdict = judgeDuplicate(alert, [candidate({ id: "r1", receipt: true, status: "accepted" })]);
  assert.equal(verdict.kind === "repeats" && verdict.of.id, "r1");
});

test("an income and an expense of one figure are two movements", () => {
  assert.deepEqual(judgeDuplicate(receipt, [candidate({ id: "refund", direction: "income" })]), { kind: "none" });
  assert.equal(judgeDuplicate(receipt, [candidate({ id: "unknown", direction: null })]).kind, "repeats");
});

// The same Bancolombia alert, by SMS from the phone and by the bank's email.
const SMS = "Bancolombia: Compraste $25.800 en COMERCIO EJEMPLO con tu T.Cred *1234, el 11/11/2026 a las 21:40.";
const EMAIL = "Bancolombia: Compraste COP25.800,00 en COMERCIO EJEMPLO con tu T.Cred *1234, el 11/11/2026 a las 21:40. Si tienes dudas, llámanos.";

const email = (overrides: Partial<DuplicateFacts> = {}): DuplicateFacts => ({ ...alert, text: EMAIL, ...overrides });
const sms = (overrides: Partial<DuplicateFacts> = {}): DuplicateFacts => ({ ...alert, fromEmail: false, text: SMS, ...overrides });

test("the email of an alert the phone already reported is its duplicate, and the other way round", () => {
  const phone = candidate({ id: "sms", rawText: SMS, receivedAt: NOW - 3 * MINUTE });
  const verdict = judgeDuplicate(email(), [phone]);
  assert.equal(verdict.kind === "repeats" && verdict.of.id, "sms");

  const bank = candidate({ id: "email", fromEmail: true, rawText: EMAIL, receivedAt: NOW - 8 * MINUTE });
  const reverse = judgeDuplicate(sms(), [bank]);
  assert.equal(reverse.kind === "repeats" && reverse.of.id, "email");
});

test("the same channel twice is two purchases", () => {
  assert.deepEqual(judgeDuplicate(email(), [candidate({ id: "first", fromEmail: true, rawText: EMAIL, receivedAt: NOW - MINUTE })]), { kind: "none" });
  assert.deepEqual(judgeDuplicate(sms(), [candidate({ id: "first", rawText: SMS, receivedAt: NOW - MINUTE })]), { kind: "none" });
});

test("another account's tail is another movement, and a text with no tail agrees with any", () => {
  const other = candidate({ id: "sms", rawText: SMS.replace("*1234", "*9876"), receivedAt: NOW - MINUTE });
  assert.deepEqual(judgeDuplicate(email(), [other]), { kind: "none" });

  const untailed = candidate({ id: "sms", rawText: "Bancolombia: Compraste $25.800 en COMERCIO EJEMPLO.", receivedAt: NOW - MINUTE });
  assert.equal(judgeDuplicate(email(), [untailed]).kind, "repeats");
  assert.equal(judgeDuplicate(email({ text: "Compraste COP25.800,00 en COMERCIO EJEMPLO" }), [candidate({ id: "sms", rawText: SMS, receivedAt: NOW - MINUTE })]).kind, "repeats");
});

test("outside the window the same figure through the other channel is another movement", () => {
  const late = candidate({ id: "sms", rawText: "Compraste $25.800 en COMERCIO EJEMPLO *1234", receivedAt: NOW - 45 * MINUTE });
  assert.deepEqual(judgeDuplicate(email({ text: "Compraste COP25.800,00 en COMERCIO EJEMPLO *1234" }), [late]), { kind: "none" });
  const inside = { ...late, receivedAt: NOW - 29 * MINUTE };
  assert.equal(judgeDuplicate(email({ text: "Compraste COP25.800,00 en COMERCIO EJEMPLO *1234" }), [inside]).kind, "repeats");
});

test("the time a bank prints outranks when the email arrived, so a late email still matches", () => {
  const phone = candidate({ id: "sms", rawText: SMS, receivedAt: NOW - 5 * 60 * MINUTE });
  assert.equal(judgeDuplicate(email(), [phone]).kind, "repeats");

  const another = candidate({ id: "sms", rawText: SMS.replace("21:40", "20:05"), receivedAt: NOW - MINUTE });
  assert.deepEqual(judgeDuplicate(email(), [another]), { kind: "none" });
});

test("a Nu card payment is a receipt of the bank's payment to Nu", () => {
  const bank = candidate({ id: "bank", fromEmail: true });
  const nu: DuplicateFacts = { ...receipt, text: "¡Ya entró tu pago! Tu pago fue de $397.167,42" };
  assert.equal(judgeDuplicate(nu, [bank]).kind, "repeats");
});

// Production, 2026-11-17: an SMS and the email of one alert, both pending.
const SMS_SHORT_YEAR = "Bancolombia: Compraste COP80.800,00 en PIZZERIA EJEMPLO con tu T.Cred *4872, el 14/11/26 a las 19:05. Si tienes dudas, encuentranos aqui: 6045109095.";
const MAIL_LONG_YEAR = "Bancolombia: JUAN, compraste COP80.800,00 en PIZZERIA EJEMPLO con tu T.Cred *4872, el 14/11/2026 a las 19:05.";

test("a short year in the SMS and a long one in the email are one printed day and time, whatever the arrival gap", () => {
  const phone = candidate({ id: "sms", occurredOn: "2026-11-14", rawText: SMS_SHORT_YEAR, receivedAt: NOW - 20 * 60 * MINUTE });
  const verdict = judgeDuplicate(email({ occurredOn: "2026-11-14", text: MAIL_LONG_YEAR, shapeHash: "d".repeat(64) }), [phone]);
  assert.equal(verdict.kind === "repeats" && verdict.of.id, "sms");

  const reverse = judgeDuplicate(
    sms({ occurredOn: "2026-11-14", text: SMS_SHORT_YEAR }),
    [candidate({ id: "mail", fromEmail: true, occurredOn: "2026-11-14", rawText: MAIL_LONG_YEAR, receivedAt: NOW + 20 * 60 * MINUTE })],
  );
  assert.equal(reverse.kind === "repeats" && reverse.of.id, "mail");
});

test("a burst of emails arriving in one second leaves each alert matched to its own SMS by the printed minute", () => {
  const phones = [
    candidate({ id: "a", occurredOn: "2026-11-14", rawText: SMS_SHORT_YEAR, receivedAt: NOW - 900 * MINUTE }),
    candidate({ id: "b", occurredOn: "2026-11-14", rawText: SMS_SHORT_YEAR.replace("19:05", "21:30"), receivedAt: NOW - 900 * MINUTE }),
  ];
  const second = email({ occurredOn: "2026-11-14", text: MAIL_LONG_YEAR.replace("19:05", "21:30"), receivedAt: NOW });
  const verdict = judgeDuplicate(second, phones);
  assert.equal(verdict.kind === "repeats" && verdict.of.id, "b");
});

test("a twelve-hour clock reads as the twenty-four-hour one", () => {
  const phone = candidate({ id: "sms", occurredOn: "2026-11-14", rawText: SMS_SHORT_YEAR, receivedAt: NOW - 20 * 60 * MINUTE });
  const verdict = judgeDuplicate(email({ occurredOn: "2026-11-14", text: MAIL_LONG_YEAR.replace("19:05", "7:05 p. m.") }), [phone]);
  assert.equal(verdict.kind, "repeats");
});
