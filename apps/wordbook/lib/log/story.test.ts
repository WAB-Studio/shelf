import assert from "node:assert/strict";
import { test } from "node:test";

import { buildWordStory } from "./story";

const word = (normalised: string, at: number, headword: string | null = normalised) => ({
  kind: "word" as const,
  headword,
  normalised,
  text: normalised,
  at,
});
const phrase = (text: string, at: number) => ({ kind: "phrase" as const, headword: null, normalised: text.toLowerCase(), text, at });

test("the story counts the lookups of a word and its forms, and names the first", () => {
  const story = buildWordStory([word("bleak", 300), word("bleaker", 100, "bleak"), word("other", 50)], "bleak");
  assert.equal(story.times, 2);
  assert.equal(story.firstAt, 100);
  assert.deepEqual(story.forms, ["bleak", "bleaker"]);
});

test("a word never looked up has no story, only the phrases that hold it", () => {
  const story = buildWordStory([phrase("The sky looked bleak", 10)], "bleak");
  assert.equal(story.times, 0);
  assert.equal(story.firstAt, null);
  assert.deepEqual(story.phrases, ["The sky looked bleak"]);
});

test("phrases come newest first, once each, and only those holding the word", () => {
  const story = buildWordStory(
    [
      word("bleak", 1),
      phrase("the house stood bleak", 20),
      phrase("The house stood bleak", 30),
      phrase("a bleaker day", 40),
      phrase("nothing to see", 50),
    ],
    "bleak",
  );
  assert.deepEqual(story.phrases, ["a bleaker day", "The house stood bleak"]);
});

test("at most four phrases are kept", () => {
  const rows = Array.from({ length: 7 }, (_, index) => phrase(`so bleak ${index}`, index));
  assert.equal(buildWordStory(rows, "bleak").phrases.length, 4);
});
