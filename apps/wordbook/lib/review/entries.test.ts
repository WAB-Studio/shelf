// RL-93: how a word's card, tap and deletion become one version, and how two versions settle.
import assert from "node:assert/strict";
import { test } from "node:test";

import { cardOf, choiceOf, entryOf, settle, type ReviewEntry } from "./entries";
import type { ReviewCard } from "./schedule";
import type { SenseChoice } from "./store";

const card = (key: string, lastReview: number | null, reps = 1): ReviewCard => ({
  key, due: 9_000, stability: 2.5, difficulty: 4.5, scheduledDays: 2, learningSteps: 0, reps, lapses: 0, state: 2, lastReview,
  introducedOn: "2026-11-12",
});
const choice = (key: string, chosenAt?: number): SenseChoice => ({ key, index: 1, signature: "sig", ...(chosenAt === undefined ? {} : { chosenAt }) });
const entry = (at: number, patch: Partial<ReviewEntry> = {}): ReviewEntry => ({ key: "frisk", at, gone: false, card: null, sense: null, ...patch });

test("a word with nothing and no deletion has no version", () => {
  assert.equal(entryOf("frisk", { card: null, choice: null, goneAt: null }), null);
});

test("a card's version is made at its last review, a tap's at the tap, and both at the later", () => {
  assert.equal(entryOf("frisk", { card: card("frisk", 500), choice: null, goneAt: null })?.at, 500);
  assert.equal(entryOf("frisk", { card: null, choice: choice("frisk", 700), goneAt: null })?.at, 700);
  assert.equal(entryOf("frisk", { card: card("frisk", 500), choice: choice("frisk", 700), goneAt: null })?.at, 700);
  assert.equal(entryOf("frisk", { card: card("frisk", 900), choice: choice("frisk", 700), goneAt: null })?.at, 900);
});

test("a tap kept before its moment was recorded counts as 0 and still travels", () => {
  const version = entryOf("frisk", { card: null, choice: choice("frisk"), goneAt: null });
  assert.equal(version?.at, 0);
  assert.deepEqual(version?.sense, { index: 1, signature: "sig", chosenAt: 0 });
});

test("a deletion is a bare version at its moment", () => {
  assert.deepEqual(entryOf("frisk", { card: null, choice: null, goneAt: 800 }), entry(800, { gone: true }));
});

test("a version rebuilds the card and the tap it was made from", () => {
  const original = card("frisk", 500);
  const tapped = choice("frisk", 700);
  const version = entryOf("frisk", { card: original, choice: tapped, goneAt: null })!;
  assert.deepEqual(cardOf(version), original);
  assert.deepEqual(choiceOf(version), tapped);
  assert.equal(cardOf(entry(1)), null);
  assert.equal(choiceOf(entry(1)), null);
});

test("with nothing on the device a version from the account stands", () => {
  const remote = entry(500, { card: cardWire() });
  assert.equal(settle(null, remote), remote);
});

test("the device's own version stands against an earlier one or an equal one", () => {
  const local = entry(500, { card: cardWire(3) });
  assert.equal(settle(local, entry(499, { card: cardWire(1) })), null);
  assert.equal(settle(local, entry(500, { card: cardWire(1) })), null);
});

test("a later version replaces the device's, whole", () => {
  const local = entry(500, { card: cardWire(3) });
  const remote = entry(600, { card: cardWire(4) });
  assert.deepEqual(settle(local, remote), remote);
});

test("the half a later version lacks is kept from the earlier one", () => {
  const senseOnly = entry(600, { sense: { index: 2, signature: "s", chosenAt: 600 } });
  const cardOnly = entry(600, { card: cardWire(5) });
  const withCard = entry(500, { card: cardWire(3) });
  const withSense = entry(500, { sense: { index: 1, signature: "t", chosenAt: 500 } });
  assert.deepEqual(settle(withCard, senseOnly), { ...senseOnly, card: withCard.card });
  assert.deepEqual(settle(withSense, cardOnly), { ...cardOnly, sense: withSense.sense });
});

test("a later deletion keeps neither half, and a later card after a deletion keeps nothing of it", () => {
  const local = entry(500, { card: cardWire(3), sense: { index: 1, signature: "t", chosenAt: 400 } });
  const deletion = entry(600, { gone: true });
  assert.deepEqual(settle(local, deletion), deletion);
  const revived = entry(700, { card: cardWire(1) });
  assert.deepEqual(settle(deletion, revived), revived);
});

test("an earlier deletion does not remove a later review", () => {
  assert.equal(settle(entry(700, { card: cardWire(1) }), entry(600, { gone: true })), null);
});

function cardWire(reps = 1): NonNullable<ReviewEntry["card"]> {
  const { key, ...rest } = card("frisk", 500, reps);
  void key;
  return rest;
}
