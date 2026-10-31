import assert from "node:assert/strict";
import { test } from "node:test";

import { gapOutWord, splitAroundWord } from "./mark-word";

test("a form is set apart where it stands as a word, with a short ending", () => {
  assert.deepEqual(splitAroundWord("The house stood bleak against the sky", ["bleak"]), [
    { text: "The house stood ", hit: false },
    { text: "bleak", hit: true },
    { text: " against the sky", hit: false },
  ]);
  assert.equal(splitAroundWord("She runs fast", ["run"]).find((piece) => piece.hit)?.text, "runs");
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
