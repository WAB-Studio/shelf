import { Text as ThemesText, type TextProps } from "@radix-ui/themes";

import styles from "./text.module.css";

// The type scale of docs/goallog/DESIGN.md "Type", one class per role, so no
// screen names a size. `sentence` is the quiet sentence (a hint, a refusal, a
// note, an empty state) in Archivo; `meta` stays for figures and dates only. `body` inherits the base step and only takes a tone.
type Variant = "title" | "heading" | "name" | "meta" | "sentence" | "line" | "body";

// docs/goallog/DESIGN.md "Tokens": `quiet` never carries a word a person must
// read, so a screen reaching for it is asking for decoration, not a sentence.
type Tone = "ink" | "secondary" | "muted" | "quiet" | "accent";

type PulsarTextProps = {
  variant?: Variant;
  tone?: Tone;
  // Pushes the text to the end of a flex row, after a name it annotates.
  end?: boolean;
  // A `title` that reads as body text from the desktop rail on, where the page
  // already has its headline above the card.
  plainWide?: boolean;
  // A section's head on the phone: a 2px ink rule above it, 18px of air under
  // the rule. From 1024 the card is the divider, so the rule goes.
  rule?: boolean;
  // A task's note read whole: line breaks kept, set off by a thin left rule.
  note?: boolean;
  // A heading's own link: ink, never the browser's blue, no underline, the
  // accent focus ring. Meant for `asChild` over a `Link`.
  link?: boolean;
  // A word inside a sentence that carries the sentence's point (a host): ink-weight 500, broken anywhere rather than overflow.
  strong?: boolean;
  // Text a person or a model wrote: a word longer than the line breaks rather than overflow it.
  breakWords?: boolean;
};

const variants: Record<Variant, string | undefined> = {
  title: styles.title,
  heading: styles.heading,
  name: styles.name,
  meta: styles.meta,
  sentence: styles.sentence,
  line: styles.line,
  body: undefined,
};

const tones: Record<Tone, string> = {
  ink: styles.ink,
  secondary: styles.secondary,
  muted: styles.muted,
  quiet: styles.quiet,
  accent: styles.accent,
};

// `color` and `highContrast` name a hue from Radix's scale and `size` a step
// from its type scale: the tone comes from the token table and the size from
// `variant`, so neither is reachable. Distributive, because `TextProps` is a
// union over the element it renders and a plain `Omit` would collapse it to one.
type Narrowed<T> = T extends unknown ? Omit<T, "color" | "highContrast" | "size"> : never;

export function Text({ variant = "body", tone, end, plainWide, rule, note, link, strong, breakWords, className, ...props }: Narrowed<TextProps> & PulsarTextProps) {
  const merged = [variants[variant], tone ? tones[tone] : undefined, end ? styles.end : undefined, plainWide ? styles.plainWide : undefined, rule ? styles.rule : undefined, note ? styles.note : undefined, link ? styles.link : undefined, strong ? styles.strong : undefined, breakWords ? styles.breakWords : undefined, className]
    .filter(Boolean)
    .join(" ");
  return <ThemesText {...props} className={merged || undefined} />;
}
