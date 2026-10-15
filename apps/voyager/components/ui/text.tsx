import { Text as ThemesText, type TextProps } from "@radix-ui/themes";

import styles from "./text.module.css";

// The one door onto Radix Themes' Text, so a headword's translation or
// definition can opt into Newsreader without a screen writing its own class
// (docs/voyager/DESIGN.md "Type").
type SerifProps = {
  // Sets the family to Newsreader; the size and weight stay whatever `size`
  // and `weight` already say.
  serif?: boolean;
  // `translation`: 21px / 1.5, a translation line. `breakTitle`/`breakBody`:
  // `RegistroVaciarConfirmar`'s own break — 15px/600 and 15px/1.6 — neither
  // a Radix step covers. `caption`: its two destructive options' own lines
  // underneath, 13px/1.5. `definitionLabel`: the label sitting above the
  // always-open English definition, 13px/600/0.06em (docs/voyager/DESIGN.md
  // "The English definition draws open, always"). `generatedProse`: the
  // generated block's own definition and example line, 16px/1.65 — a step
  // past the dictionary definition's Radix `size="2"`, since a generated
  // line is a different design surface (`PalabraGeneradaOscuroMovil`).
  // `exampleTranslation`: the example's Spanish line beneath it, 15px, no
  // Radix step. `generatedMark`: the small «GENERADA» pill beside the
  // generated label — bordered, never a coloured badge
  // (docs/voyager/DESIGN.md "Metadata labels"). `pendingHint`: the one line
  // `PalabraGenerandoOscuroMovil` draws while the network is still out,
  // 14px italic — the translation above is already whole and this line
  // only holds the block's place.
  variant?:
    | "translation"
    | "breakTitle"
    | "breakBody"
    | "caption"
    | "definitionLabel"
    | "generatedProse"
    | "exampleTranslation"
    | "generatedMark"
    | "pendingHint";
  // The muted tone every caption, status line and secondary link takes
  // (docs/voyager/DESIGN.md "Tokens"), so a screen never reaches for Radix's
  // own `color="gray"`. `"quietest"` is the second, dimmer muted role the
  // same table names — first needed by `RegistroVaciarConfirmar`'s captions.
  muted?: boolean | "quietest";
  // English text, so a screen reader switches to an English voice.
  english?: boolean;
};

function withSerif(
  serif: boolean | undefined,
  variant: SerifProps["variant"],
  muted: SerifProps["muted"],
  className: string | undefined,
): string | undefined {
  const classes = [
    serif || variant === "translation" ? styles.serif : undefined,
    variant === "translation" ? styles.translation : undefined,
    variant === "breakTitle" ? styles.breakTitle : undefined,
    variant === "breakBody" ? styles.breakBody : undefined,
    variant === "caption" ? styles.caption : undefined,
    variant === "definitionLabel" ? styles.definitionLabel : undefined,
    variant === "generatedProse" ? styles.generatedProse : undefined,
    variant === "exampleTranslation" ? styles.exampleTranslation : undefined,
    variant === "generatedMark" ? styles.generatedMark : undefined,
    variant === "pendingHint" ? styles.pendingHint : undefined,
    muted === true ? styles.muted : undefined,
    muted === "quietest" ? styles.mutedQuietest : undefined,
    className,
  ].filter(Boolean);
  return classes.length > 0 ? classes.join(" ") : undefined;
}

export function Text({ serif, variant, muted, english, className, ...props }: TextProps & SerifProps) {
  return (
    <ThemesText
      {...props}
      lang={english ? "en" : props.lang}
      className={withSerif(serif, variant, muted, className)}
    />
  );
}
