import { Heading, type HeadingProps } from "@radix-ui/themes";

import styles from "./headword.module.css";

type HeadwordSize = "default" | "offer" | "hero";

function sizeClassName(size: HeadwordSize | undefined): string {
  if (size === "offer") return styles.offer;
  return size === "hero" ? styles.hero : styles.headword;
}

// The one door onto a headword's exact type: 40px / 700 / -0.02em, in Fraunces, none of it
// a Radix step (docs/wordbook/DESIGN.md "Type"). `size="offer"` is the
// smaller 27px/500 the `PalabraConFlexion` board gives a lemma offered
// beneath a word's own entry — the size difference is the only thing that
// tells the two headings apart. `size="hero"` is the entry's own headword,
// 48 to 64px by the width it has, over a dictionary entry's lines.
export function Headword({
  className,
  size,
  ...props
}: Omit<HeadingProps, "size"> & { size?: HeadwordSize }) {
  const base = sizeClassName(size);
  return <Heading lang="en" {...props} className={className ? `${base} ${className}` : base} />;
}
