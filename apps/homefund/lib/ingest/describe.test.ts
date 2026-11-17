import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAmount } from "@/lib/money";
import { interpretQuickEntry, readAccountTails } from "@/lib/transactions/interpret";

import {
  describeAlert,
  looksLikeBankAlert,
  looksLikeCashWithdrawal,
  onlyBankAccount,
  paidOwnCard,
  readableName,
  repairDescription,
  withoutClock,
} from "./describe";

// Synthetic messages that mimic the shapes Bancolombia sends; no real figure, name or number.
const DATE = "el 14/11/2026 a las 19:05";
const HELP = "Si tienes dudas, encuentranos aqui: 6045109095.";

test("every Bancolombia shape yields a short description, by SMS or by email", () => {
  const cases: [string, string | null][] = [
    [`Bancolombia: Compraste COP80.800,00 en PIZZA Y PASTA YORK con tu T.Cred *4872, ${DATE}. ${HELP}`, "Pizza y Pasta York"],
    [`Bancolombia: Compraste $12.000 en Tienda La Esquina con tu T.Deb *4872, ${DATE}.`, "Tienda La Esquina"],
    [`Bancolombia: JUAN, compraste COP9.100,00 en RAPPI COLOMBIA*DL con tu T.Cred *4872, ${DATE}.`, "Rappi Colombia"],
    [`Bancolombia: Pagaste $39,000.00 por codigo QR desde tu producto *3397 a la llave @drogueriamia ${DATE}. ${HELP}`, "drogueriamia"],
    [`Bancolombia: Transferiste $20,000.00 desde tu cuenta *3397 a la cuenta *3118882698 ${DATE}. ${HELP}`, "Transferencia a *2698"],
    [`Bancolombia: Transferiste $10,000.00 a la llave 1090480304 desde tu producto 3397 ${DATE} a LUIS ALBERTO TORRES GARCIA. ${HELP}`, "Luis Alberto Torres Garcia"],
    [`Bancolombia: Recibiste una transferencia de JULIAN ANDRES PEREZ en tu cuenta *3397 por $450,000.00 ${DATE}. ${HELP}`, "De Julian Andres Perez"],
    [`Bancolombia: Recibiste una transferencia por $340,000 de CARLOS NIETO en tu cuenta de Ahorros ${DATE}.`, "De Carlos Nieto"],
    [`Bancolombia: Pagaste $1,000,000.00 a FONDO NACIONAL DEL AHORRO desde tu producto 3397 ${DATE}. ${HELP}`, "Fondo Nacional del Ahorro"],
    [`Bancolombia: Recibiste una consignacion por $500,000 desde el corresponsal BARRIO EJEMPLO en CUCUTA ${DATE}.`, "Consignación corresponsal"],
    ["Bancolombia: Recibiste una consignacion por $500,000 en tu cuenta de Ahorros.", "Consignación"],
    ["Banco de Bogota: Tu compra por 94,208 fue aprobada con Tarjeta Crédito 4505 el 06/11/26 18:36:05 en FARMATODO PRADOS DEL E ¿Dudas? Llama a la Servilinea 6013338877", "Farmatodo Prados del E"],
    ["Banco de Bogota: Tu compra por 12,500 fue aprobada con Tarjeta Crédito 4505 el 06/11/26 18:36:05 en Anthropic* Claude Sub ¿Dudas? Llama a la Servilinea", "Anthropic* Claude Sub"],
    ["Bancolombia: Hola, tu clave cambió.", null],
    ["Almuerzo 15000", null],
  ];
  for (const [text, expected] of cases) assert.equal(describeAlert(text), expected, text);
});

test("the email's boilerplate around the sentence changes nothing", () => {
  const body = `Alertas y Notificaciones Listo! Todo salió bien con tus movimientos Bancolombia: Compraste COP80.800,00 en PIZZA Y PASTA YORK con tu T.Cred *4872, ${DATE}. ${HELP} Estamos cerca.`;

  assert.equal(describeAlert(body), "Pizza y Pasta York");
});

test("a name written with lowercase is kept, a shouted one is read as a name", () => {
  assert.equal(readableName("Mercado Libre"), "Mercado Libre");
  assert.equal(readableName("CASA DE LA MONEDA"), "Casa de la Moneda");
  assert.equal(readableName("EMPRESA S.A.S"), "Empresa S.A.S");
});

test("only a bank's alert is cleaned as one", () => {
  assert.equal(looksLikeBankAlert("Bancolombia: Compraste $1 en X"), true);
  assert.equal(looksLikeBankAlert("compraste pan 2000"), false);
});

test("Banco de Bogotá's card SMS reads its comma-grouped figure, its tail, its short date and its business", () => {
  const text =
    "Banco de Bogota: Tu compra por 94,208 fue aprobada con Tarjeta Crédito 4505 el 06/11/26 18:36:05 en FARMATODO PRADOS DEL E ¿Dudas? Llama a la Servilinea";
  const read = interpretQuickEntry(text, { categories: [], accounts: [], defaultAccountId: null, yearGuard: "dated" });

  assert.equal(parseAmount(read.amountPesos ?? ""), 9_420_800);
  assert.equal(read.occurredAt, "2026-11-06");
  assert.equal(read.direction, "expense");
  assert.deepEqual([...readAccountTails(text, read.direction)], ["4505"]);
  assert.equal(looksLikeBankAlert(text), true);
});

test("a Bancolombia alert with no tail takes the one Bancolombia bank account, never a card or a second one", () => {
  const savings = { id: "a", name: "Ahorros", institution: "Bancolombia", subtype: "bank" };
  const card = { id: "b", name: "Bancolombia Visa", institution: null, subtype: "card" };
  const other = { id: "c", name: "Nequi", institution: "Nequi", subtype: "bank" };
  const text = "Bancolombia: Recibiste una consignacion por $500,000";

  assert.equal(onlyBankAccount(text, [savings, card, other]), "a");
  assert.equal(onlyBankAccount(text, [savings, { ...savings, id: "d", name: "Ahorro viaje" }]), null);
  assert.equal(onlyBankAccount(text, [card, other]), null);
  assert.equal(onlyBankAccount("Nequi: Recibiste $5", [savings]), null);
});

test("a payment to the institution of exactly one of the person's cards pays that card", () => {
  const nu = { id: "nu", institution: "Nu", subtype: "card" };
  const bogota = { id: "bogota", institution: "Banco de Bogotá", subtype: "card" };
  const savings = { id: "ahorros", institution: "Nu", subtype: "bank" };
  const sms = "Bancolombia: Pagaste $4,305.47 a NU Compania de Financiamiento desde tu producto 3397 el 14/11/2026 a las 19:05.";
  const receipt = "PSE - Transacción Aprobada Valor: $4.305,47 Empresa: NU Compañía de Financiamiento Descripción: Pago tarjeta Nu Fecha: 14/11/2026";

  assert.equal(paidOwnCard(sms, [nu, bogota, savings]), "nu");
  assert.equal(paidOwnCard(receipt, [nu, bogota]), "nu");
  assert.equal(paidOwnCard(sms, [nu, { ...nu, id: "nu2", subtype: "loan" }]), null);
  assert.equal(paidOwnCard(sms, [bogota, savings]), null);
  assert.equal(paidOwnCard("Bancolombia: Pagaste $5,000 a GONZALEZ NUTRICION desde tu producto 3397.", [nu]), null);
  assert.equal(paidOwnCard("Bancolombia: Pagaste $5,000 a Banco de Bogota S.A desde tu producto 3397.", [nu, bogota]), "bogota");
  assert.equal(describeAlert(sms), "NU Compania de Financiamiento");
});

test("a reference that starts with three capitals is no currency mark, so it is never read as the amount", () => {
  const text = "Transacción aprobada en EMPRESA DCB5FA06 — por un valor de $3.543.210,00 fue Aprobada Referencia: DCB5FA06";
  const read = interpretQuickEntry(text, { categories: [], accounts: [], defaultAccountId: null, yearGuard: "any" });

  assert.equal(parseAmount(read.amountPesos ?? ""), 354_321_000);
  assert.equal(parseAmount(interpretQuickEntry("Compraste COP80.800,00 en X", { categories: [], accounts: [], defaultAccountId: null }).amountPesos ?? ""), 8_080_000);
});

// Synthetic: the shapes of the damaged descriptions, with invented merchants, figures and numbers.
const NOUN_PURCHASE = "Bancolombia le informa Compra por $38.000 en RAPPI RESTAURANTE 15:32. 12/11/2026 T.Cred *4521. Inquietudes al 018000000000.";
const APPROVED_PURCHASE = "Davivienda: Compra aprobada por $52.300 en EXITO COLINA con tu T.Cred *4521 el 12/11/2026.";

test("a purchase named by its noun yields the business, never the sentence with its amount cut out", () => {
  assert.equal(describeAlert(NOUN_PURCHASE), "Rappi Restaurante");
  assert.equal(describeAlert(APPROVED_PURCHASE), "Exito Colina");
  assert.equal(describeAlert("Bancolombia le informa Compra por $ en RAPPI* 15:32. 12/11/2026 T.Cred *4521."), "Rappi");
  assert.equal(describeAlert("Nequi: Pagaste en UBER TRIP"), "Uber Trip");
  assert.equal(describeAlert("Nequi: Pagaste $18.500 en UBER TRIP el 12/11/2026."), "Uber Trip");
});

test("a row stored with a damaged description reads the business again from its message", () => {
  assert.equal(repairDescription("Bancolombia le informa Compra por $ en RAPPI* 15:32. 12/11/2026", NOUN_PURCHASE, "RAPPI*"), "Rappi Restaurante");
  assert.equal(repairDescription(": Pagaste en UBER TRIP", "Nequi: Pagaste en UBER TRIP", "UBER TRIP"), "Uber Trip");
  // No shape fits the message: the business stands in for the broken sentence.
  assert.equal(repairDescription("Da : Compra aprobada por $ en TIENDA UNO", "Texto raro de un banco", "TIENDA UNO"), "Tienda Uno");
  // A sound description is left alone, and so is a damaged one with no business to replace it.
  assert.equal(repairDescription("Almuerzo con Ana", "Almuerzo con Ana 25000", null), "Almuerzo con Ana");
  assert.equal(repairDescription(": algo", "Texto raro", null), ": algo");
  assert.equal(repairDescription(null, "Texto raro", "X"), null);
});

test("an ATM withdrawal is told from a purchase", () => {
  assert.equal(looksLikeCashWithdrawal("Bancolombia: Retiraste $300.000 en CAJERO CALLE 80 con tu T.Deb *1234."), true);
  assert.equal(looksLikeCashWithdrawal("Cajero DAVIVIENDA CALLE 80 $300.000"), true);
  assert.equal(looksLikeCashWithdrawal("Retiro por $200.000 en cajero."), true);
  assert.equal(looksLikeCashWithdrawal("Bancolombia: Compraste $12.000 en Tienda La Esquina con tu T.Deb *4872."), false);
  assert.equal(describeAlert("Cajero DAVIVIENDA CALLE 80 $300.000"), "Retiro en cajero");
});

test("a description never keeps the time of day the bank printed after the business", () => {
  assert.equal(withoutClock("RAPPI* 15:32"), "RAPPI");
  assert.equal(withoutClock("UBER TRIP 08:12"), "UBER TRIP");
  assert.equal(withoutClock("Éxito Colina"), "Éxito Colina");
  assert.equal(repairDescription("UBER TRIP 08:12", "Uber trip 08:12", null), "UBER TRIP");
});
