// RF-196: whether a bank email reports a movement that happened. Pure: subject and body in, verdict out.

export type NonMovementReason =
  | "failed"
  | "statement"
  | "support"
  | "reminder"
  | "promotion"
  | "bill"
  | "no_movement_signal";

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

// A bill the person still has to pay (RF-207): an invoice, a payment slip or the bank's «ya puedes pagarla».
// Judged on the subject first, since a bill's footer often says «si ya pagaste, omite este mensaje».
const BILL_SUBJECT = /^(?:factura\b|\d{5,};[^;]+;|ticket de pago\b)/;
const BILL_BODY =
  /\b(esta lista para que la pagues|factura que inscribiste|ticket de banco para pago|valor a pagar|tu factura claro esta disponible)\b/;
// A reminder that a due date is near, whatever its footer says about payments already made.
const REMINDER_SUBJECT = /\b(paga tu|pague su|recuerda pagar|tu fecha de pago|desde cualquier dispositivo)\b/;
// A store's notices about an order or a question: the payment itself came in another email.
const NOT_A_MOVEMENT_SUBJECT =
  /\b(llego tu compra|la factura de la compra|las facturas de la compra|tienes un mensaje nuevo|te respondieron|esta en camino|opinando|tu opinion|transaccion\s+#?\d*\s*pendiente)\b/;
// What says money moved: a verb or phrase of the alerts the banks send.
const MOVEMENT =
  /\b(compraste|pagaste|transferiste|recibiste|retiraste|te enviaron|te transfirieron|te consignaron|pago exitoso|pago hecho|entro tu pago|aprobada|tu plata de \w+ ya esta|hiciste un pago|realizaste (?:una transferencia|un pago|un envio|un retiro)|total pagado|monto recibido)\b/;
// A wording that only counts as the subject: in a body it turns up in footers and newsletters.
const MOVEMENT_SUBJECT =
  /\b(envio con bre-?b exitoso|transaccion\s+#?\d*\s*(?:aprobada|aceptada)|compra por \$|comprobante de pago|tu recibo|se le acaba de pagar)\b/;
// A merchant's thanks for a purchase carries its invoice as an attachment and names no figure.
const AMOUNTLESS_RECEIPT_SUBJECT = /\bgracias por tu compra\b/;
// «Alertas y Notificaciones» is the sender's title; its body must still name the operation.
const ALERT_TITLE = /\balertas y notificaciones\b/;
const ALERT_OPERATION = /\b(compra|pago|transferencia|retiro)\b/;
// A money figure: «$52.300», «COP 9.100,00», a number with a thousands group, or a bare
// figure of four or more digits such as Nequi's «2467834.2», as long as it is not a year.
const AMOUNT = /(?:\$|\bcop)\s?\d|\d{1,3}(?:[.,]\d{3})+|\b(?!(?:19|20)\d{2}\b)\d{4,}(?:[.,]\d{1,2})?\b/;

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
  if (BILL_SUBJECT.test(subjectText)) return { movement: false, reason: "bill" };
  if (REMINDER_SUBJECT.test(subjectText)) return { movement: false, reason: "reminder" };
  if (NOT_A_MOVEMENT_SUBJECT.test(subjectText)) return { movement: false, reason: "no_movement_signal" };
  if (SUPPORT_SUBJECT.test(subjectText)) return { movement: false, reason: "support" };
  if (BILL_BODY.test(text)) return { movement: false, reason: "bill" };
  if (AMOUNTLESS_RECEIPT_SUBJECT.test(subjectText)) return { movement: true };
  const signal =
    MOVEMENT.test(text) || MOVEMENT_SUBJECT.test(subjectText) || (ALERT_TITLE.test(text) && ALERT_OPERATION.test(text));
  if (signal && AMOUNT.test(text)) return { movement: true };
  if (REMINDER.test(text)) return { movement: false, reason: "reminder" };
  if (PROMOTION.test(text)) return { movement: false, reason: "promotion" };
  return { movement: false, reason: "no_movement_signal" };
}
