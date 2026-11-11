import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { emailToMessage, keyInPayloads, readInboundEmail, verifySvixSignature } from "./email";

const KEY = `whk_${"AbC-dEf_1".repeat(4)}1234567`;

test("Resend's event and a flat body read the same fields", () => {
  assert.equal(readInboundEmail({ type: "email.received", data: { email_id: "e1" } })?.emailId, "e1");
  assert.equal(readInboundEmail({ subject: "S", text: "T" })?.text, "T");
  assert.equal(readInboundEmail("nope"), null);
});

test("the key is found as a recipient, a plus tag or a forwarding header, case kept", () => {
  assert.equal(keyInPayloads({ data: { to: [`${KEY}@in.example.com`] } }), KEY);
  assert.equal(keyInPayloads({ to: `Casa <casa+${KEY}@in.example.com>` }), KEY);
  assert.equal(
    keyInPayloads({ to: ["yo@gmail.com"] }, { headers: { "x-forwarded-to": `${KEY}@in.example.com` } }),
    KEY,
  );
  assert.equal(keyInPayloads({ to: ["otro@in.example.com"] }), null);
});

test("a forwarded email drops the forward header and keeps the bank's own date line", () => {
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
      "> Fecha: 10/11/2026",
    ].join("\n"),
    html: "",
  });

  assert.equal(
    message,
    "Alertas y Notificaciones Bancolombia: Compraste $52.300,00 en EXITO Fecha: 10/11/2026",
  );
});

test("an HTML-only email decodes its accents and is cut around its amount", () => {
  const message = emailToMessage({
    subject: "",
    text: "",
    html: `<head><title>Banco</title></head><p>${"Hola ".repeat(80)}</p><p>Transacci&oacute;n en CAF&Eacute; por &#x24;12.000</p>`,
  });

  assert.ok(message.includes("Transacción en CAFÉ por $12.000"));
  assert.ok(!message.includes("Banco"));
  assert.ok(message.length <= 320);
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
