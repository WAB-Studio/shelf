import { Heading, type HeadingProps } from "@radix-ui/themes";

import styles from "./headword.module.css";

type HeadwordSize = "default" | "offer";

function sizeClassName(size: HeadwordSize | undefined): string {
  return size === "offer" ? styles.offer : styles.headword;
}

// The one door onto a headword's exact type: 34px / 500 / -0.02em, none of it
// a Radix step (docs/wordbook/DESIGN.md "Type"). `size="offer"` is the
// smaller 27px/500 the `PalabraConFlexion` board gives a lemma offered
// beneath a word's own entry — the size difference is the only thing that
// tells the two headings apart.
export function Headword({
  className,
  size,
  ...props
}: Omit<HeadingProps, "size"> & { size?: HeadwordSize }) {
  const base = sizeClassName(size);
  return <Heading lang="en" {...props} className={className ? `${base} ${className}` : base} />;
}
