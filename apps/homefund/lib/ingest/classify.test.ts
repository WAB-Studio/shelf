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

test("payment reminders from a bank newsletter are refused as reminders", () => {
  for (const subject of [
    "Wilson, anticípate y mantén todo al día",
    "Organizarte hoy te da calma",
    "Realiza tus pagos a tiempo y evita reportes",
    "Haz tu pago de forma fácil y segura",
  ]) {
    assert.equal(rejected(subject, "Paga desde la app. Valor $120.000."), "reminder", subject);
  }
});

test("store card offers are refused as promotions", () => {
  assert.equal(rejected("CMR SIN cuota de manejo + $150mil", "Pídela hoy."), "promotion");
  assert.equal(rejected("Tenemos una CMR para ti", "Conoce tus beneficios."), "promotion");
});

test("newsletters and awareness mail carry no movement signal", () => {
  assert.equal(rejected("Hoy es un gran día, ¡Lo sabemos!", "Te contamos las novedades del mes."), "no_movement_signal");
  assert.equal(rejected("¿Te llamaron de la Servilínea para confirmar…?", "Nadie del banco te pide tu clave."), "no_movement_signal");
  assert.equal(rejected("Ya puedes consignar efectivo en Oxxo", "Desde $10.000 en cualquier tienda."), "no_movement_signal");
});

test("a support reply is refused as support", () => {
  assert.equal(rejected("Sobre tu mensaje: Reporte de movimiento M123", "Gracias por escribirnos 2026."), "support");
});

test("an email with an amount but no movement signal is refused", () => {
  assert.equal(rejected("Hola", "Algo de $5.000"), "no_movement_signal");
});

test("an alerts title needs its body to name the operation", () => {
  assert.equal(rejected("Alertas y Notificaciones", "Tu clave cambió. Saldo $5.000"), "no_movement_signal");
  assert.equal(rejected("Alertas y Notificaciones", "Retiro por $200.000 en cajero."), null);
});

test("a bare figure with no currency mark still counts as the amount, a lone year does not", () => {
  assert.equal(rejected("Tu plata de PayPal ya está en Nequi", "Recibiste en tu Nequi 1234567.8 que enviaste desde PayPal."), null);
  assert.equal(rejected("Recibiste un mensaje", "Recibiste esto en 2026."), "no_movement_signal");
});

test("the movements of wallets, gateways and merchants are accepted", () => {
  const emails: [string, string][] = [
    ["¡Envío con Bre-B exitoso!", "Conoce los detalles. Realizaste una transferencia a PERSONA EJEMPLO por $24.000 Origen cuenta • 1234."],
    ["ecollect: Credito Hipotecario Confirmación #5337 BANCOLOMBIA", "Total Pagado $ 500,000.00 Detalle: CREDITO HIPOTECARIO NRO. 6039"],
    ["Transacción #3841 ACEPTADA en ePayco", "Ha realizado una transacción en COMERCIO EJEMPLO. Transacción Aceptada $65,000.00 COP"],
    ["-- Transacción Aprobada: [1153eea7] --", "Tu transacción ha sido aprobada. Valor 119400"],
    ["Recibiste un pago a través de Pagos a terceros de Wompi", "Monto recibido: $23.379 Destinatario: PERSONA EJEMPLO"],
    ["Pago viagogo 6799- Se le acaba de pagar", "Pago: $ 2.802,75 Si ves un cargo incorrecto, envía una reclamación."],
    ["Comprobante de pago Referencia Claro No.1163", "Estado de su solicitud: APPROVED Referencia de pago Claro: 1163 Valor: $97.110"],
    ["Tu recibo de Airbnb", "DESGLOSE DEL PRECIO Total (USD) $150,77 PAGO AMEX •••• 1234 $63,06"],
  ];
  for (const [subject, body] of emails) assert.equal(rejected(subject, body), null, subject);
});

test("a merchant's thanks for a purchase is a movement although it names no figure", () => {
  assert.equal(rejected("¡Muchas gracias por tu compra en Farmatodo!", "Adjunto encontrarás tu factura."), null);
  const priced = (body: string) => {
    const verdict = judge("¡Muchas gracias por tu compra en Farmatodo!", body);
    return verdict.movement && verdict.priced;
  };
  assert.equal(priced("Llámanos al 317 648 0137. Adjunto tu factura."), false);
  assert.equal(priced("Total $45.000. Adjunto tu factura."), true);
  assert.equal(rejected("¡Muchas gracias por tu compra!", "Tu pago fue rechazado."), "failed");
});

test("an invoice, a payment slip or a bank's bill notice is a bill, not a payment", () => {
  assert.equal(rejected("Factura EMPRESA 517262 de julio de 2026", ""), "bill");
  assert.equal(rejected("800153993;COMCEL S.A.;E6090430280;01;CLARO;MOVIL", "Tu factura Claro está disponible. VALOR A PAGAR $ 44.743,71"), "bill");
  assert.equal(
    rejected("Ticket de pago 9000112240 - Inmobiliaria Ejemplo", "Adjunto ticket de banco para pago. Valor $1.300.000"),
    "bill",
  );
  assert.equal(
    rejected(
      "Alertas y Notificaciones",
      "¡Te interesa! Buenas noticias: La factura que inscribiste EMPRESA con referencia 576327 está lista para que la pagues. Vence el 04/11/2026. ¿Recibiste un correo sospechoso?",
    ),
    "bill",
  );
});

test("a store's order and question notices report no payment, and a due date is a reminder", () => {
  assert.equal(rejected("Llegó tu compra, ¡que la disfrutes!", "Compraste 2 productos. Entregado en 540005."), "no_movement_signal");
  assert.equal(rejected("La factura de la compra #2000015 ya está disponible", "Compraste Linterna 15000 Lm."), "no_movement_signal");
  assert.equal(rejected("Tienes un mensaje nuevo en Producto Ejemplo", "Recibiste este e-mail. Ref 377373737"), "no_movement_signal");
  assert.equal(rejected("Transacción #3841 PENDIENTE en ePayco", "Transacción Pendiente $65,000.00 COP"), "no_movement_signal");
  assert.equal(rejected("Tu fecha de pago ya está cerca Lulo Bank", "Si ya pagaste omite este mensaje. Valor de la cuota: $325.374,57"), "reminder");
});

// RF-208: the notices a payment leaves after the bank's own alert.
const isReceipt = (subject: string, body: string) => {
  const verdict = judge(subject, body);
  return verdict.movement ? verdict.receipt : null;
};

test("PSE, gateway and merchant notices are receipts; a bank or wallet alert is not", () => {
  const receipts: [string, string][] = [
    ["PSE - Transacción Aprobada ✅ CUS 510567233", "Valor: $ 123.429,00 Empresa: EMPRESA EJEMPLO"],
    ["Transacción aprobada en COMERCIO EJEMPLO [1091900964]", "La transacción por un valor de $447.932,00 fue Aprobada"],
    ["Transacción APROBADA en COMERCIO EJEMPLO", "¡Pago exitoso! COP $93,560"],
    ["Transacción #3841 ACEPTADA en ePayco", "Transacción Aceptada $65.000,00 COP"],
    ["Transacción Aprobada:", "Tu transacción ha sido aprobada. Valor 119400"],
    ["Compra por $122.000 COP en COMERCIO EJEMPLO", "Transacción aprobada"],
    ["ecollect: Credito Hipotecario Confirmación #5337 BANCOLOMBIA", "Total Pagado $ 500,000.00"],
    ["Recibiste un pago a través de Pagos a terceros de Wompi", "Monto recibido: $23.379"],
    ["Compraste Producto Ejemplo", "TOTAL: $144609"],
    ["¡Muchas gracias por tu compra en Farmatodo!", "Adjunto encontrarás tu factura."],
    ["Comprobante de pago Referencia Claro No.1163", "Estado: APPROVED Valor: $97.110"],
    ["Tu recibo de Airbnb", "Total (USD) $150,77"],
  ];
  for (const [subject, body] of receipts) assert.equal(isReceipt(subject, body), true, subject);

  const alerts: [string, string][] = [
    ["Alertas y Notificaciones", "Bancolombia: Compraste COP9.100,00 en TIENDA XYZ con tu T.Cred *1234."],
    ["¡Pago exitoso!", "Hiciste un pago en COMERCIO EJEMPLO por $79.000"],
    ["Comprobante de Pago Claro", "Listo tu pago en Claro. Pagaste con Nequi tu factura por $5.500"],
    ["Pago hecho", "¡Listo! pagaste tu crédito por $325.374,57."],
    ["¡Envío con Bre-B exitoso!", "Realizaste una transferencia a PERSONA EJEMPLO por $24.000"],
    ["¡Recibiste plata por Bre-B!", "Recibiste $76.000 de PERSONA EJEMPLO"],
    ["¡Ya entró tu pago!", "Tu pago fue de $397.167,42"],
  ];
  for (const [subject, body] of alerts) assert.equal(isReceipt(subject, body), false, subject);
});
