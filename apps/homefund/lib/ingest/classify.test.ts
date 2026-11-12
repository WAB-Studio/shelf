import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyBankEmail } from "./classify";

const judge = (subject: string, body: string) => classifyBankEmail({ subject, body });
const rejected = (subject: string, body: string) => {
  const verdict = judge(subject, body);
  return verdict.movement ? null : verdict.reason;
};

test("real alerts are movements", () => {
  const alerts: [string, string][] = [
    ["Alertas y Notificaciones", "Bancolombia: Compraste COP9.100,00 en TIENDA XYZ con tu T.Cred *1234."],
    ["¡Pago exitoso!", "Pagaste $45.000 en COMERCIO EJEMPLO desde tu Nequi."],
    ["Tu plata de PayPal ya está en Nequi", "Recibiste $120.000 en tu cuenta."],
    ["Pago hecho", "Transferiste $30.000 a una cuenta Lulo."],
    ["¡Recibiste plata por Bre-B!", "Te enviaron $80.000 por Bre-B."],
    ["¡Ya entró tu pago!", "Entró tu pago de $250.000 a tu cuenta Nu."],
    ["PSE - Transacción Aprobada", "Tu transacción por $470.000 fue aprobada."],
  ];
  for (const [subject, body] of alerts) assert.equal(rejected(subject, body), null, subject);
});

test("a rejected or failed transaction is refused", () => {
  assert.equal(rejected("PSE - Transacción Rechazada ❌", "Tu pago por $470.000 no se realizó."), "failed");
  assert.equal(rejected("Compra", "Tu pago $20.000 fue fallida"), "failed");
  assert.equal(rejected("Resultado", "Transacción no exitosa por $10.000"), "failed");
});

test("a statement is refused", () => {
  assert.equal(rejected("Extracto Tarjeta de Crédito 15 Octubre 2026", "Tu pago mínimo es $85.000"), "statement");
});

test("a support thread is refused", () => {
  assert.equal(rejected("Sobre tu caso pendiente: Reporte de movimiento", "Gracias por escribirnos, caso 2026."), "support");
});

test("a reminder to pay is refused", () => {
  assert.equal(rejected("Paga tu tarjeta", "Hazlo desde cualquier dispositivo. Valor $120.000"), "reminder");
});

test("promotions and awareness mail are refused", () => {
  assert.equal(rejected("Gánate $150 mil pidiendo tu tarjeta", "Aprovecha esta oferta."), "promotion");
  assert.equal(rejected("Ampliamos el monto de tu crédito", "Ahora hasta $1.400.000."), "promotion");
  assert.equal(rejected("Más cuotas, más millas", "Hasta 6.500.000 millas."), "promotion");
  assert.equal(rejected("Subimos las tasas de los CDT", "Desde $100.000."), "promotion");
  assert.equal(rejected("Cuídate del fraude", "No compartas tu clave. Llama al 5943."), "promotion");
});

test("an email that says nothing either way is kept", () => {
  assert.equal(rejected("Hola", "Algo de $5.000"), null);
});
