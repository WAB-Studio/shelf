import { splitAroundWord } from "@/lib/word/mark-word";

import { Highlight } from "./highlight";

// A phrase with the word it is about on the marigold: the forms the word was searched under, and the
// inflections that trace back to them.
export function MarkedWord({ text, forms }: { text: string; forms: readonly string[] }) {
  return (
    <>
      {splitAroundWord(text, forms).map((piece, index) =>
        piece.hit ? <Highlight key={index}>{piece.text}</Highlight> : piece.text,
      )}
    </>
  );
}
