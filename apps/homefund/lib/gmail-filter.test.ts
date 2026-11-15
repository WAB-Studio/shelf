import assert from "node:assert/strict";
import { test } from "node:test";

import { BANK_EMAILS_GMAIL_QUERY } from "./gmail-filter";

test("the filter names the alerts' senders and the receipts' senders", () => {
  for (const sender of ["an.notificacionesbancolombia.com", "nequi.com.co", "lulobank.com", "achcolombia.com.co", "placetopay.com", "payulatam.com"]) {
    assert.ok(BANK_EMAILS_GMAIL_QUERY.includes(sender), sender);
  }
});

test("a merchant counts only by its receipt's subject, and offers and failures are left out", () => {
  assert.ok(BANK_EMAILS_GMAIL_QUERY.includes("(from:mercadolibre.com.co subject:Compraste)"));
  assert.ok(BANK_EMAILS_GMAIL_QUERY.includes('(from:farmatodo.com subject:"gracias por tu compra")'));
  assert.ok(BANK_EMAILS_GMAIL_QUERY.includes("-from:(info.lulobank.com OR"));
  assert.ok(BANK_EMAILS_GMAIL_QUERY.includes("-subject:(extracto OR rechazada"));
  assert.equal((BANK_EMAILS_GMAIL_QUERY.match(/\(/g) ?? []).length, (BANK_EMAILS_GMAIL_QUERY.match(/\)/g) ?? []).length);
});
