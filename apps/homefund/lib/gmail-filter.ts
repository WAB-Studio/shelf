// RF-209: the Gmail search that picks the emails HomeFund reads (RF-187): what the banks and wallets
// send, and the receipts a payment leaves behind (RF-208). Pasted in Gmail it becomes the forwarding filter.

// Alerts: the bank or the wallet says the money moved.
const ALERT_SENDERS = [
  "an.notificacionesbancolombia.com",
  "ayn.notificacionesbancolombia.com",
  "bancolombia.com.co",
  "nequi.com.co",
  "nu.com.co",
  "lulobank.com",
  "bancodebogota.com.co",
  "bancofalabella.com.co",
  "davivienda.com",
  "bbva.com.co",
  "daviplata.com",
];

// Receipts whose every email is one: PSE's and the payment gateways'.
const RECEIPT_SENDERS = [
  "achcolombia.com.co",
  "placetopay.com",
  "wompi.co",
  "wompi.com",
  "epayco.com",
  "payulatam.com",
  "bold.co",
  "ecollect.co",
];

// Merchants send orders, questions and offers too: only the email that is the receipt, by its subject.
const MERCHANT_RECEIPTS: [sender: string, subject: string][] = [
  ["mercadolibre.com.co", "Compraste"],
  ["farmatodo.com", '"gracias por tu compra"'],
  ["claro.com.co", '"comprobante de pago"'],
  ["airbnb.com", '"tu recibo"'],
];

// Subdomains of the senders above that only send offers and surveys.
const OFFER_SENDERS = [
  "info.lulobank.com",
  "soynu.com.co",
  "email.wompi.com",
  "somos.bold.co",
  "novedades.farmatodo.com",
  "experiencia.farmatodo.com",
];

const NOT_A_MOVEMENT_SUBJECTS = ["extracto", "rechazada", "rechazado", '"reporte de movimiento"'];

export const BANK_EMAILS_GMAIL_QUERY = [
  "(",
  `from:(${[...ALERT_SENDERS, ...RECEIPT_SENDERS].join(" OR ")})`,
  ...MERCHANT_RECEIPTS.map(([sender, subject]) => ` OR (from:${sender} subject:${subject})`),
  ")",
  ` -from:(${OFFER_SENDERS.join(" OR ")})`,
  ` -subject:(${NOT_A_MOVEMENT_SUBJECTS.join(" OR ")})`,
].join("");
