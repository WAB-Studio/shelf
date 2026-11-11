import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import {
  emailToMessage,
  keyFromAddresses,
  readInboundEmail,
  verifySvixSignature,
} from "./email";

const KEY = "whk_AbC-dEf_123";

test("a Resend event and a flat body read the same recipients", () => {
  const resend = readInboundEmail({
    type: "email.received",
    data: { email_id: "e1", to: [`${KEY}@in.example.com`], subject: "S" },
  });
  const flat = readInboundEmail({ to: `Yo <${KEY}@in.example.com>`, text: "T" });

  assert.equal(resend?.emailId, "e1");
  assert.equal(keyFromAddresses(resend?.to ?? []), KEY);
  assert.equal(keyFromAddresses(flat?.to ?? []), KEY);
  assert.equal(readInboundEmail("nope"), null);
});

test("the key rides as the local part or as a plus tag, case kept", () => {
  assert.equal(keyFromAddresses([`casa+${KEY}@in.example.com`]), KEY);
  assert.equal(keyFromAddresses(["otro@in.example.com"]), null);
});

test("a forwarded email keeps the bank's words without the forward header", () => {
  const message = emailToMessage({
    subject: "RV: Alertas y Notificaciones",
    text: [
      "---------- Forwarded message ---------",
      "De: Bancolombia <alertas@notificacionesbancolombia.com>",
      "Fecha: mar, 11 nov 2026",
      "Asunto: Alertas y Notificaciones",
      "Para: yo@example.com",
      "",
      "> Bancolombia: Compraste $52.300,00 en EXITO",
      "> con tu T.Deb *1234, el 11/11/2026.",
    ].join("\n"),
    html: "",
  });

  assert.equal(
    message,
    "Alertas y Notificaciones Bancolombia: Compraste $52.300,00 en EXITO con tu T.Deb *1234, el 11/11/2026.",
  );
});

test("an HTML-only email is read as text and cut to the ingest ceiling", () => {
  const message = emailToMessage({
    subject: "",
    text: "",
    html: `<style>p{}</style><p>Pagaste&nbsp;&#36;10.000</p><div>${"x".repeat(400)}</div>`,
  });

  assert.ok(message.startsWith("Pagaste $10.000 x"));
  assert.equal(message.length, 320);
});

test("a Svix signature verifies only with its secret, body and a fresh timestamp", () => {
  const secret = `whsec_${Buffer.from("secret-bytes").toString("base64")}`;
  const body = '{"type":"email.received"}';
  const sign = (b: string) =>
    createHmac("sha256", Buffer.from("secret-bytes")).update(`msg_1.1000.${b}`).digest("base64");
  const args = {
    secret,
    id: "msg_1",
    timestamp: "1000",
    signature: `v1,bad v1,${sign(body)}`,
    body,
    nowSeconds: 1100,
  };

  assert.equal(verifySvixSignature(args), true);
  assert.equal(verifySvixSignature({ ...args, body: `${body} ` }), false);
  assert.equal(verifySvixSignature({ ...args, nowSeconds: 1000 + 301 }), false);
  assert.equal(verifySvixSignature({ ...args, signature: null }), false);
});
