// RF-196: whether a bank email reports a movement that happened. Pure: subject and body in, verdict out.

export type NonMovementReason = "failed" | "statement" | "support" | "reminder" | "promotion" | "no_movement_signal";

export type EmailVerdict = { movement: true } | { movement: false; reason: NonMovementReason };

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

// A transaction the bank did not carry out; refused whatever else the text says.
const FAILED = /\b(rechazad[oa]s?|fallid[oa]s?|declinad[oa]s?|denegad[oa]s?|no (?:fue )?exitos[oa]s?)\b/;
// Subject-only: a statement, or a thread about a case, claim or report with the bank.
const STATEMENT_SUBJECT = /\bextracto\b/;
const SUPPORT_SUBJECT =
  /\b(caso|casos|pqr|radicado|reclamo|ticket|sobre tu mensaje|reporte de movimiento)\b/;

// What says money moved: a verb or phrase of the alerts the banks send.
const MOVEMENT =
  /\b(compraste|pagaste|transferiste|recibiste|retiraste|te enviaron|te transfirieron|te consignaron|pago exitoso|pago hecho|entro tu pago|aprobada|tu plata de \w+ ya esta)\b/;
// «Alertas y Notificaciones» is the sender's title; its body must still name the operation.
const ALERT_TITLE = /\balertas y notificaciones\b/;
const ALERT_OPERATION = /\b(compra|pago|transferencia|retiro)\b/;
// A money figure: «$52.300», «COP 9.100,00», or a number with a thousands group.
const AMOUNT = /(?:\$|\bcop)\s?\d|\d{1,3}(?:[.,]\d{3})+/;

// Only weighed when no movement phrase is present: bills to pay, offers and awareness mail.
const REMINDER =
  /\b(paga tu|pague su|recuerda pagar|haz tu pago|pagos a tiempo|anticipate|organizarte|al dia|pago minimo|fecha limite de pago|desde cualquier dispositivo|tu factura esta lista|vence)\b/;
const PROMOTION =
  /\b(ganate|gana|cmr|cuota de manejo|oferta|promo|promocion|descuento|aprovecha|ampliamos|amplia|subimos|millas|cuotas|tasas?|cdt|credito|te regalamos|beneficio|cupo|preaprobad[oa]|fraude|estafa|suplantacion|phishing|no compartas|cuidate|seguridad)\b/;

/**
 * Whether the email reports a movement that happened. Only a positive signal (a movement
 * phrase and an amount) says so; every other email is refused, with the clearest reason it has.
 */
export function classifyBankEmail({ subject, body }: { subject: string; body: string }): EmailVerdict {
  const subjectText = fold(subject);
  const text = fold(`${subject} ${body}`);

  if (FAILED.test(text)) return { movement: false, reason: "failed" };
  if (STATEMENT_SUBJECT.test(subjectText)) return { movement: false, reason: "statement" };
  if (SUPPORT_SUBJECT.test(subjectText)) return { movement: false, reason: "support" };
  const signal = MOVEMENT.test(text) || (ALERT_TITLE.test(text) && ALERT_OPERATION.test(text));
  if (signal && AMOUNT.test(text)) return { movement: true };
  if (REMINDER.test(text)) return { movement: false, reason: "reminder" };
  if (PROMOTION.test(text)) return { movement: false, reason: "promotion" };
  return { movement: false, reason: "no_movement_signal" };
}
