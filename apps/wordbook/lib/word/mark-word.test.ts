import assert from "node:assert/strict";
import { test } from "node:test";

import { gapOutWord, splitAroundWord } from "./mark-word";

test("a form is set apart where it stands as a word, with a short ending", () => {
  assert.deepEqual(splitAroundWord("The house stood bleak against the sky", ["bleak"]), [
    { text: "The house stood ", hit: false },
    { text: "bleak", hit: true },
    { text: " against the sky", hit: false },
  ]);
});

test("a form inside a longer word is left alone, and the match ignores case", () => {
  assert.equal(splitAroundWord("Bookmarks are not books", ["book"]).filter((piece) => piece.hit).map((piece) => piece.text).join("|"), "books");
  assert.equal(splitAroundWord("Book it", ["book"])[0].hit, true);
});

test("no form leaves the phrase whole", () => {
  assert.deepEqual(splitAroundWord("Nothing here", []), [{ text: "Nothing here", hit: false }]);
  assert.deepEqual(splitAroundWord("", ["a"]), [{ text: "", hit: false }]);
});

test("the gap takes the place of the word", () => {
  assert.equal(gapOutWord("the house stood bleak against the sky", ["bleak"]), "the house stood _____ against the sky");
});

const hits = (text: string, forms: string[]) => splitAroundWord(text, forms).filter((piece) => piece.hit).map((piece) => piece.text);

test("a short word matches only as written: «a» is not «and», «I» is not «it», «be» is not «been»", () => {
  assert.deepEqual(hits("a cat and a dog", ["a"]), ["a", "a"]);
  assert.deepEqual(hits("I think it is", ["i"]), ["I"]);
  assert.deepEqual(hits("it has been so", ["be"]), []);
});

test("a longer word matches its real inflections, never a longer word that merely starts with it", () => {
  assert.deepEqual(hits("a bleaker day", ["bleak"]), ["bleaker"]);
  assert.deepEqual(hits("the books were old", ["book"]), ["books"]);
  assert.deepEqual(hits("a bookmark", ["book"]), []);
});
