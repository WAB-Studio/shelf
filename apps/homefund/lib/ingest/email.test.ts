import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import {
  emailDescription,
  emailMerchant,
  emailToMessage,
  emailWords,
  keyInPayloads,
  readInboundEmail,
  verifySvixSignature,
} from "./email";

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

  assert.equal(message, "Bancolombia: Compraste $52.300,00 en EXITO Fecha: 10/11/2026");
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

// A bank's plain-text part: image alts and bracketed links glued to its sentences, hard-wrapped lines.
const ALERT_TEXT = [
  "Logo Banco [https://cdn.example.com/templates/a1/img/header-logo.png]yellow-icon [https://cdn.example.com/templates/a1/img/ok.png]",
  "¡Listo!Todo salió bien con tus movimientosBancolombia: JUAN, compraste COP32.850,00 en COMERCIO",
  "EJEMPLO*DL con tu T.Cred *1234, el 08/08/2026 a las 17:03. Si tienes dudas,",
  "encuentranos aqui: 6045109095.Estamos cerca.icon1 [https://cdn.example.com/templates/a1/img/dots.png]",
  "Controla tu dinero. DESCUBRIR MÁS",
  "[https://www.example.com/centro-de-ayuda/canales?utm_source=alertas&utm_campaign=promo]",
].join("\n");

test("images, links and the bank's boilerplate never reach the message: the operative sentence comes first", () => {
  const message = emailToMessage({ subject: "Alertas y Notificaciones", text: ALERT_TEXT, html: "" });

  assert.equal(
    message,
    "Bancolombia: JUAN, compraste COP32.850,00 en COMERCIO EJEMPLO*DL con tu T.Cred *1234, el 08/08/2026 a las 17:03.",
  );
});

test("a link's address is never judged: the classifier reads the body without it", () => {
  const { body } = emailWords({ subject: "x", text: ALERT_TEXT, html: "" });

  assert.ok(!/https?:|\[|promo/i.test(body));
});

test("a subject that states the outcome stays ahead of the sentence, and a gateway's reference leaves it", () => {
  const message = emailToMessage({
    subject: "Transacción APROBADA en COMERCIO EJEMPLO - ref. AB12_345-CD67",
    text: "¡Pago exitoso! COP $93,560 Si tienes preguntas, escribe al comercio. Comercio COMERCIO EJEMPLO Fecha y Hora 09/11/2026 19:05",
    html: "",
  });

  assert.ok(message.startsWith("Transacción APROBADA en COMERCIO EJEMPLO — "));
  assert.ok(!message.includes("AB12"));
  assert.ok(message.includes("$93,560"));
});

test("a long receipt keeps its subject and is cut around the amount at a word boundary", () => {
  const message = emailToMessage({
    subject: "Compraste Producto Ejemplo",
    text: `${"Resumen de tu envío a la dirección del comprador. ".repeat(12)}COMPRA NETA: $144609 IVA: $0 TOTAL: $144609 ****1234`,
    html: "",
  });

  assert.ok(message.length <= 320);
  assert.ok(message.startsWith("Compraste Producto Ejemplo — "));
  assert.ok(message.includes("$144609"));
  assert.ok(message.includes("****1234"));
});

test("a description is the sentence a person acts on, from the amount's remainder", () => {
  const cases: [string, string][] = [
    [
      "Bancolombia: JUAN, compraste COP en COMERCIO EJEMPLO*DL con tu T.Cred *1234, el 08/08/2026 a las 17:03.",
      "Compraste en COMERCIO EJEMPLO*DL con tu T.Cred *1234",
    ],
    [
      "Bancolombia: JUAN, transferiste $ desde tu cuenta *1234 a la cuenta *5678 el 21/08/2026 a las 10:29. ¿Dudas? Llámanos.",
      "Transferiste desde tu cuenta *1234 a la cuenta *5678",
    ],
    [
      "Bancolombia: Recibiste un pago de Nomina de EMPRESA EJEMPLO por $ en tu cuenta de Ahorros el 30/07/2026 a las 17:06.",
      "Recibiste un pago de Nomina de EMPRESA EJEMPLO",
    ],
    [
      "Bancolombia: Pagaste $ a EMPRESA EJEMPLO desde tu producto 1234 el 06/09/2026 18:54:12.",
      "Pagaste a EMPRESA EJEMPLO desde tu producto 1234",
    ],
    ["¡Pago exitoso! — Hiciste un pago en COMERCIO EJEMPLO SAS por $ Fecha: El 11 de octubre de 2026", "Hiciste un pago en COMERCIO EJEMPLO SAS"],
    ["Compra en COMERCIO EJEMPLO — Transacción aprobada Resumen de tu compra $", "Compra en COMERCIO EJEMPLO"],
  ];
  for (const [raw, expected] of cases) assert.equal(emailDescription(raw), expected, raw);
});

test("the bank's boilerplate ahead of its label never reaches the description", () => {
  assert.equal(
    emailDescription("Alertas y Notificaciones Listo! Todo salió bien con tus movimientos Bancolombia: Compraste COP en COMERCIO EJEMPLO con tu T.Cred *1234, el 08/08/2026 a las 17:03."),
    "Compraste en COMERCIO EJEMPLO con tu T.Cred *1234",
  );
});

test("a receipt that names its business in a field adds it to a subject that does not", () => {
  assert.equal(
    emailDescription("PSE - Transacción Aprobada CUS 510567233 — ¡Hola, Juan Ejemplo! Valor: $ Empresa: EMPRESA EJEMPLO SA Descripción: Pago factura Fecha: 25/07/2026"),
    "PSE - Transacción Aprobada — EMPRESA EJEMPLO SA",
  );
});

test("a receipt's business is read from its field, or from the gateway's «realizada en»", () => {
  assert.equal(emailMerchant("Valor: $5 Empresa: EMPRESA EJEMPLO SA Descripción: Pago Fecha: 25/07/2026"), "EMPRESA EJEMPLO SA");
  assert.equal(emailMerchant("La transacción 1153 realizada en GRUPO EJEMPLO , fue aprobada"), "GRUPO EJEMPLO");
  assert.equal(emailMerchant("Compraste en COMERCIO EJEMPLO"), null);
});
