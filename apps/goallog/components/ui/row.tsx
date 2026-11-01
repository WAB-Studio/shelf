"use client";

import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { Text } from "./text";
import styles from "./row.module.css";

// docs/goallog/DESIGN.md: a row is a real `<button>`, never a div, at least 56px
// tall, ruled from the next by a hairline. A border box only as `card`, a link row the boards draw so.
// Writing a fact costs one tap, so the whole row is the target (RNP-02).
type RowProps = Omit<ComponentPropsWithoutRef<"button">, "children" | "name"> & {
  // Nothing acts on the row (a closed month's task, RP-143): it draws as text, never as a control, whatever
  // handlers it is handed.
  still?: boolean;
  // What sits at the head of the row — usually the mark, sometimes a plain
  // label (`Semana.dc.html`'s own day row has no mark of its own to lead
  // with).
  leading?: ReactNode;
  // The row's own display name — never the native `<button name>` form
  // attribute, which this type deliberately excludes above: nothing in this
  // app submits a row as a form control, and a `ReactNode` here (the week's
  // dot grid, not just a string) would otherwise collide with it.
  name: ReactNode;
  // The line under the name: mono, muted, a date or a count.
  meta?: ReactNode;
  // `sentence` sets the line in Archivo for a mixed line (a sentence whose
  // figures and dates are `<Figure variant="meta">` spans, each on one line).
  // Default `meta`: the whole line in mono, as every call site reads today.
  metaVariant?: "meta" | "sentence";
  // What sits at the end — a measure, a chevron.
  trailing?: ReactNode;
  // Drops the hairline for the last row of a group, where the group's own
  // spacing already separates it.
  rule?: boolean;
  // Splits the row into two real buttons — the leading mark and the rest —
  // for a row whose mark does a different act than its name
  // (`one-off-row.tsx`'s mark still finishes it; its name opens the sheet
  // that deletes it, RP-22). Absent, the row stays the one button it always
  // was. Names the mark's own button for a reader that has no visible text
  // to read there.
  onLeadingClick?: () => void;
  // Turns the leading block into the row's one link (`Semana.dc.html`'s past
  // day) and the row into a plain `div`: a link cannot sit inside a
  // `<button>`. `leadingLabel` names it for a reader.
  leadingHref?: string;
  leadingLabel?: string;
  // The name reads muted: a commitment already met, still tappable
  // (`HoyCuenta.dc.html`).
  quiet?: boolean;
  // The whole row is one link and nothing else: a goal in the list of goals.
  href?: string;
  // From 768px these replace `meta` and join `trailing`: the desktop row
  // carries the goal's month and its last day (`MetasCentroEscritorio`).
  wideMeta?: ReactNode;
  wideTrailing?: ReactNode;
  // Under 768px a line of its own between the name and `meta`, in the same
  // face as `meta`; from 768px it is gone, `wideMeta` says it there.
  narrowMetaAbove?: ReactNode;
  // Up to two lines of free text under the name and its meta, line breaks
  // kept, clipped with an ellipsis (`TareaNotaGuardada`).
  preview?: string | null;
  // A line the person wrote, whole, under the row and aligned with its name: a quantity's note. It sits outside the
  // button, so it is neither part of its accessible name nor of its tap target. Plain rows only.
  note?: string | null;
  // A control of its own at the row's end, a sibling of the row's button
  // because a button cannot hold one (`TareaNotaGuardada`'s note button).
  end?: ReactNode;
  // A link row drawn as a white bordered card, not a ruled line.
  card?: boolean;
  // How deep the row sits in a tree of goals: 0 at the top, 2 at most. The
  // row and its hairline start that many 20px steps in (`JerarquiaArbol`).
  level?: 0 | 1 | 2;
  // A 20px slot before the name, kept on every row of a tree level so the
  // level shares one left edge. Empty unless `fold` fills it.
  foldSlot?: boolean;
  // Fills the slot with the fold arrow: a button beside the row's link, never
  // inside it. `label` names the act it does next.
  fold?: { expanded: boolean; label: string; onToggle: () => void };
};

export const Row = forwardRef<HTMLButtonElement, RowProps>(function Row(
  {
    leading,
    name,
    meta,
    metaVariant = "meta",
    trailing,
    rule = true,
    onLeadingClick,
    leadingHref,
    leadingLabel,
    quiet,
    href,
    wideMeta,
    wideTrailing,
    narrowMetaAbove,
    preview,
    note,
    end,
    card,
    still,
    level = 0,
    foldSlot,
    fold,
    className,
    type = "button",
    disabled,
    onClick,
    ...props
  },
  ref,
) {
  const merged = [
    styles.row,
    rule ? undefined : styles.flush,
    card ? styles.card : undefined,
    level === 1 ? styles.level1 : level === 2 ? styles.level2 : undefined,
    !still && (onLeadingClick || end || (href && (fold || foldSlot))) ? styles.split : undefined,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <span className={styles.content}>
      <span className={styles.body}>
        <Text as="span" variant="name" tone={quiet ? "muted" : undefined}>
          {name}
        </Text>
        {narrowMetaAbove ? (
          <Text as="span" variant={metaVariant} className={styles.narrowOnly}>
            {narrowMetaAbove}
          </Text>
        ) : null}
        {meta ? (
          <Text as="span" variant={metaVariant} className={wideMeta ? styles.narrowOnly : undefined}>
            {meta}
          </Text>
        ) : null}
        {wideMeta ? (
          <Text as="span" variant={metaVariant} className={styles.wideOnly}>
            {wideMeta}
          </Text>
        ) : null}
        {preview ? (
          <Text as="span" variant="meta" tone="secondary" className={styles.preview}>
            {preview}
          </Text>
        ) : null}
      </span>
      {wideTrailing ? <span className={`${styles.trailing} ${styles.wideOnly}`}>{wideTrailing}</span> : null}
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
    </span>
  );

  if (still) {
    return (
      <div className={merged} {...(props as ComponentPropsWithoutRef<"div">)}>
        {leading ? <span className={styles.leading}>{leading}</span> : null}
        {body}
      </div>
    );
  }

  if (href && (fold || foldSlot)) {
    const Arrow = fold?.expanded ? ChevronDown : ChevronRight;
    return (
      <div className={merged}>
        {fold ? (
          <button
            type="button"
            className={styles.foldButton}
            onClick={fold.onToggle}
            aria-expanded={fold.expanded}
            aria-label={fold.label}
          >
            <Arrow size={16} strokeWidth={1.5} aria-hidden />
          </button>
        ) : (
          <span className={styles.foldSlot} />
        )}
        <Link href={href} className={styles.bodyButton}>
          {leading ? <span className={styles.leading}>{leading}</span> : null}
          {body}
        </Link>
      </div>
    );
  }

  if (href) {
    return (
      <Link href={href} className={merged}>
        {leading ? <span className={styles.leading}>{leading}</span> : null}
        {body}
      </Link>
    );
  }

  if (leadingHref) {
    return (
      <div className={merged}>
        <Link href={leadingHref} className={styles.leadingLink} aria-label={leadingLabel}>
          {leading}
        </Link>
        {body}
      </div>
    );
  }

  if (onLeadingClick || end) {
    return (
      <div className={merged}>
        {leading && onLeadingClick ? (
          <button
            type="button"
            className={styles.leadingButton}
            onClick={onLeadingClick}
            disabled={disabled}
            aria-label={leadingLabel}
          >
            {leading}
          </button>
        ) : null}
        <button
          ref={ref}
          type={type}
          className={styles.bodyButton}
          onClick={onClick}
          disabled={disabled}
          {...props}
        >
          {onLeadingClick || !leading ? null : <span className={styles.leading}>{leading}</span>}
          {body}
        </button>
        <span className={styles.end}>{end}</span>
      </div>
    );
  }


  const button = (
    <button ref={ref} type={type} className={note ? `${merged} ${styles.flush}` : merged} disabled={disabled} onClick={onClick} {...props}>
      {leading ? <span className={styles.leading}>{leading}</span> : null}
      {body}
    </button>
  );
  if (!note) return button;
  return (
    <div className={rule ? `${styles.noted} ${styles.ruled}` : styles.noted}>
      {button}
      <Text as="p" variant="sentence" tone="secondary" className={leading ? `${styles.note} ${styles.noteLead}` : styles.note} data-part="row-note">
        {note}
      </Text>
    </div>
  );
});
