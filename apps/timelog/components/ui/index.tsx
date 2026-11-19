import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import styles from "./ui.module.css";

const join = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

// One column, 760 at most, the same on every screen so the header never moves.
export function Page({ children }: { children: ReactNode }) {
  return <main className={styles.page}>{children}</main>;
}

// A titled part of a screen: its title in the display face, its total at the right. No box, space only.
export function Section({ title, figure, children }: { title: ReactNode; figure?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {figure === undefined ? null : <Text mono>{figure}</Text>}
      </div>
      {children}
    </section>
  );
}

type Step = { href: string; label: string };

function PeriodStep({ step, glyph }: { step?: Step; glyph: string }) {
  return step === undefined ? <span className={styles.periodSpacer} aria-hidden="true" /> : <Link href={step.href} className={styles.periodStep} aria-label={step.label}>{glyph}</Link>;
}

// The top line of a day or a week: its name and, under it in muted, what it adds up to, with ‹ and › one period away.
// Both arrows are buttons with a name; where a period has no neighbour its place stays empty so the title never moves.
// `children` is the small line under the title («Actualizado hace…», the way back to now).
export function Period({ title, summary, prev, next, children }: { title: string; summary?: string; prev?: Step; next?: Step; children?: ReactNode }) {
  return (
    <header className={styles.period}>
      <div className={styles.periodRow}>
        <PeriodStep step={prev} glyph="‹" />
        <h1 className={styles.periodTitle}>
          {title}
          {summary === undefined ? null : <span className={styles.periodSummary}>{` · ${summary}`}</span>}
        </h1>
        <PeriodStep step={next} glyph="›" />
      </div>
      {children === undefined ? null : <div className={styles.periodMeta}>{children}</div>}
    </header>
  );
}

// Rows in one column.
export function Rows({ children }: { children: ReactNode }) {
  return <div className={styles.rows}>{children}</div>;
}

export function Stack({ gap = 2, children }: { gap?: 1 | 2 | 3 | 4; children: ReactNode }) {
  return <div className={join(styles.stack, styles[`gap${gap}`])}>{children}</div>;
}

// Two ends of one line: a name and its figure, a title and its steps.
export function Between({ children }: { children: ReactNode }) {
  return <div className={styles.between}>{children}</div>;
}

export type Tone = "code" | "ai" | "work" | "messages" | "games" | "social" | "shopping" | "study" | "system" | "other" | "claude" | "claudeWeb" | "claudeApp";

type MeterSize = "large" | "default" | "compact";

// A name and its figure over the bar under them, 48 tall at least (DESIGN «Hoy»). A long name
// truncates; the figure never wraps.
export function Meter({ name, figure, share, label, size = "default", tone, wrap }: { name: ReactNode; figure: ReactNode; share: number; label: string; size?: MeterSize; tone?: Tone; wrap?: boolean }) {
  return (
    <div className={join(styles.stack, styles.gap1, styles.meter, size === "large" && styles.meterLarge, size === "compact" && styles.meterCompact)}>
      <div className={styles.line}>
        <Text truncate={!wrap} wrap={wrap}>{name}</Text>
        <Text mono>{figure}</Text>
      </div>
      <Bar share={share} label={label} tone={tone} />
    </div>
  );
}

// A row that opens onto its detail: the native <details>, so it works without a script and by keyboard. The › sits at
// the row's start, centred on the row, in a 24-wide hit area.
export function Disclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className={styles.disclosure}>
      <summary className={styles.summary}>
        <span className={styles.chevron} aria-hidden="true">›</span>
        <div className={styles.summaryRow}>{summary}</div>
      </summary>
      <div className={styles.disclosureBody}>{children}</div>
    </details>
  );
}

// Keeps a row with no detail in line with its neighbours that open: the width of a ›.
export function Gutter({ children }: { children: ReactNode }) {
  return <div className={styles.gutter}>{children}</div>;
}

export function Title({ children }: { children: ReactNode }) {
  return <h1 className={styles.title}>{children}</h1>;
}

type TextVariant = "total" | "row" | "meta";

// `wrap` lets a long text take two lines before it is cut. `untitled` leaves the title to a parent that already has one.
export function Text({ variant = "row", mono, truncate, wrap, untitled, as = "span", children }: { variant?: TextVariant; mono?: boolean; truncate?: boolean; wrap?: boolean; untitled?: boolean; as?: "span" | "p"; children: ReactNode }) {
  const Tag = as;
  // A cut text carries its whole self as a hover and long-press title.
  const title = !untitled && (truncate || wrap) && typeof children === "string" ? children : undefined;
  return <Tag title={title} className={join(styles[variant], mono && styles.mono, !mono && styles.name, truncate && styles.truncate, wrap && styles.clamp)}>{children}</Tag>;
}

export type CompositionPart = { key: string; tone: Tone; seconds: number; name: string; figure: string };

// A whole in parts: one stacked bar and, under it, each part's name and figure in words, so no
// part is told by colour alone.
export function Composition({ parts, label }: { parts: CompositionPart[]; label: string }) {
  const total = Math.max(1, parts.reduce((sum, part) => sum + part.seconds, 0));
  return (
    <div className={styles.composition}>
      <div className={styles.stacked} role="img" aria-label={label}>
        {parts.map((part) => (
          <div key={part.key} className={join(styles.part, styles[`tone_${part.tone}`])} style={{ flexGrow: part.seconds / total }} />
        ))}
      </div>
      <ul className={styles.legend}>
        {parts.map((part) => (
          <li key={part.key} className={styles[`tone_${part.tone}`]}>
            <span className={styles.swatch} aria-hidden="true" />
            <Text>{part.name}</Text>
            <Text mono>{part.figure}</Text>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type DayRow = { key: string; label: string; figure: string; share: number; future: boolean; description: string; href: string };

// The seven days of a week as rows, each a link to its day with its full figure and a bar against the week's longest day.
// A day not reached is dimmed, reads «—» and opens nothing.
export function DayRows({ days }: { days: DayRow[] }) {
  return (
    <Rows>
      {days.map((day) =>
        day.future ? (
          <div key={day.key} className={styles.rowDim}>
            <Meter name={day.label} figure="—" share={0} label={day.description} />
          </div>
        ) : (
          <Link key={day.key} href={day.href} className={styles.rowLink}>
            <Meter name={day.label} figure={day.figure} share={day.share} label={day.description} />
          </Link>
        ),
      )}
    </Rows>
  );
}

// The shared header: the logo mark and name on the left, the sections on the right.
export function Header({ brand, href, children }: { brand: ReactNode; href: string; children?: ReactNode }) {
  return (
    <header className={styles.header}>
      <Link href={href} className={styles.brand}>
        <span className={styles.logo} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        {brand}
      </Link>
      <div className={styles.headerEnd}>{children}</div>
    </header>
  );
}

// One bar, its length a share of the longest (DESIGN: the only graphic).
export function Bar({ share, label, tone }: { share: number; label: string; tone?: Tone }) {
  const percent = Math.max(0, Math.min(1, share)) * 100;
  return (
    <div className={join(styles.track, tone && styles[`tone_${tone}`])} role="img" aria-label={label}>
      <div className={styles.fill} style={{ width: `${percent}%` }} />
    </div>
  );
}

export function TextLink({ current, pill, button, ...props }: ComponentProps<typeof Link> & { current?: boolean; pill?: boolean; button?: boolean }) {
  return <Link {...props} aria-current={current ? "page" : undefined} className={join(styles.link, current && styles.current, pill && styles.pill, button && styles.pillPrimary)} />;
}

export function Nav({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav aria-label={label} className={styles.nav}>
      {children}
    </nav>
  );
}

// `danger` is the solid red of a confirmed destructive press; `quietDanger` is red text alone, the way in.
export function Button({ quiet, danger, quietDanger, ...props }: ComponentProps<"button"> & { quiet?: boolean; danger?: boolean; quietDanger?: boolean }) {
  return <button {...props} className={join(styles.button, quiet && styles.quiet, danger && styles.danger, quietDanger && styles.quietDanger)} />;
}

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={styles.input} />;
}

// An input with its label always visible above it.
export function Field({ label, ...props }: ComponentProps<"input"> & { label: string }) {
  return (
    <label className={styles.field}>
      <Text variant="meta">{label}</Text>
      <Input {...props} />
    </label>
  );
}

// Answers a press in place: «¿Revocar?» and its two ends.
export function Confirm({ children }: { children: ReactNode }) {
  return <div className={styles.confirm}>{children}</div>;
}

export function Form(props: ComponentProps<"form">) {
  return <form {...props} className={styles.form} />;
}

// `row` puts the text and its copy button on one line.
export function CodeBlock({ row, children }: { row?: boolean; children: ReactNode }) {
  return <div className={row ? styles.codeRow : styles.codeBlock}>{children}</div>;
}

export function Code({ children }: { children: ReactNode }) {
  return <pre className={styles.code}>{children}</pre>;
}
