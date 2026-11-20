import Link from "next/link";
import type { ComponentProps, CSSProperties, ReactNode } from "react";

import styles from "./ui.module.css";

const join = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

// Desktop first (DESIGN «Escritorio»): with `shell`, from 1100 the header is a sidebar and the screen takes the width
// beside it; under 1100 one column, 760 at most, the header on top. Without `shell`, one column at every width.
export function Page({ shell, header, children }: { shell?: boolean; header: ReactNode; children: ReactNode }) {
  return (
    <main className={join(styles.page, shell && styles.shell)}>
      {header}
      <div className={styles.content}>{children}</div>
    </main>
  );
}

// The columns of a desktop screen: `main` the wide one (the apps), `middle` (the classes) and `aside` (sites, projects,
// Claude) beside it. Under 1100 they stack in that order.
export function Columns({ main, middle, aside }: { main: ReactNode; middle?: ReactNode; aside: ReactNode }) {
  return (
    <div className={join(styles.columns, middle !== undefined && styles.columns3)}>
      <Stack gap={4}>{main}</Stack>
      {middle === undefined ? null : <Stack gap={4}>{middle}</Stack>}
      <Stack gap={4}>{aside}</Stack>
    </div>
  );
}

// The figures a screen opens with, side by side: four on the desktop, two a row on the phone.
export function Stats({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className={styles.stats}>
      {children}
    </section>
  );
}

// One figure: what it is, the figure large (in its class's colour when `tone` names one), a line under it.
export function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: Tone }) {
  return (
    <div className={join(styles.stat, tone && styles[`tone_${tone}`], tone && styles.statTone)}>
      <span className={styles.meta}>{label}</span>
      <span className={styles.statValue}>{value}</span>
      {note === undefined ? null : <span className={styles.meta}>{note}</span>}
    </div>
  );
}

export type ClassRow = { key: string; tone: Tone; name: string; share: string; figure: string };

// Each class on its own line: its colour, its name, its share of the whole and its time, so no class is told by colour alone.
export function ClassRows({ rows }: { rows: ClassRow[] }) {
  return (
    <ul className={styles.classRows}>
      {rows.map((row) => (
        <li key={row.key} className={styles[`tone_${row.tone}`]}>
          <span className={styles.swatch} aria-hidden="true" />
          <Text truncate>{row.name}</Text>
          <span className={styles.meta}>{row.share}</span>
          <Text mono>{row.figure}</Text>
        </li>
      ))}
    </ul>
  );
}

// A form screen («Llaves», «Exportar») keeps a reading width inside the wide page.
export function Narrow({ children }: { children: ReactNode }) {
  return <div className={styles.narrow}>{children}</div>;
}

// A titled part of a screen: its title in the display face, its total at the right. No box, space only; `panel` makes it
// a raised panel on the desktop, where it stands in a column beside others.
export function Section({ title, figure, panel, children }: { title: ReactNode; figure?: ReactNode; panel?: boolean; children: ReactNode }) {
  return (
    <section className={join(styles.section, panel && styles.panel)}>
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

// The top line of a day or a week: its name with ‹ and › one period away; its total is the first figure under it.
// Both arrows are buttons with a name; where a period has no neighbour its place stays empty so the title never moves.
// `children` is the small line beside it («Actualizado hace…», the way back to now).
export function Period({ title, prev, next, children }: { title: string; prev?: Step; next?: Step; children?: ReactNode }) {
  return (
    <header className={styles.period}>
      <div className={styles.periodRow}>
        <PeriodStep step={prev} glyph="‹" />
        <h1 className={styles.periodTitle}>{title}</h1>
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

export type CompositionPart = { key: string; tone: Tone; seconds: number };

// A whole in parts: one stacked bar. Its parts are written in words beside it (ClassRows), never by colour alone.
export function Composition({ parts, label }: { parts: CompositionPart[]; label: string }) {
  const total = Math.max(1, parts.reduce((sum, part) => sum + part.seconds, 0));
  return (
    <div className={styles.stacked} role="img" aria-label={label}>
      {parts.map((part) => (
        <div key={part.key} className={join(styles.part, styles[`tone_${part.tone}`])} style={{ flexGrow: part.seconds / total }} />
      ))}
    </div>
  );
}

export type DayRow = { key: string; label: string; figure: string; share: number; future: boolean; description: string; href: string };

// The seven days of a week, each a link to its day with its full figure and a bar against the week's longest day: rows
// on the phone, seven columns standing side by side on the desktop. A day not reached is dimmed and opens nothing.
export function DayRows({ days }: { days: DayRow[] }) {
  return (
    <ol className={join(styles.rows, styles.days)}>
      {days.map((day) => {
        const body = (
          <>
            <Bar standing share={day.share} label={day.description} />
            <span className={styles.dayName}>{day.label}</span>
            <Text mono>{day.figure}</Text>
          </>
        );
        return (
          <li key={day.key} className={day.future ? styles.rowDim : undefined}>
            {day.future ? <div className={styles.day}>{body}</div> : <Link href={day.href} className={join(styles.day, styles.rowLink)}>{body}</Link>}
          </li>
        );
      })}
    </ol>
  );
}

// The shared header: the logo mark and name on the left, the sections on the right; `sidebar` stands it at the left of the
// screen from 1100, the sections stacked under the name.
export function Header({ brand, href, sidebar, children }: { brand: ReactNode; href: string; sidebar?: boolean; children?: ReactNode }) {
  return (
    <header className={join(styles.header, sidebar && styles.sidebar)}>
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

// One bar, its length a share of the longest (DESIGN: the only graphic). `standing` stands it up from 1100.
export function Bar({ share, label, tone, standing }: { share: number; label: string; tone?: Tone; standing?: boolean }) {
  const clamped = Math.max(0, Math.min(1, share));
  return (
    <div className={join(styles.track, tone && styles[`tone_${tone}`], standing && styles.standing)} role="img" aria-label={label}>
      <div className={styles.fill} style={{ "--share": clamped } as CSSProperties} />
    </div>
  );
}

export function TextLink({ current, pill, button, ...props }: ComponentProps<typeof Link> & { current?: boolean; pill?: boolean; button?: boolean }) {
  return <Link {...props} aria-current={current ? "page" : undefined} className={join(styles.link, current && styles.current, pill && styles.pill, button && styles.pillPrimary)} />;
}

// `vertical` stacks the sections from 1100, for a sidebar.
export function Nav({ label, vertical, children }: { label: string; vertical?: boolean; children: ReactNode }) {
  return (
    <nav aria-label={label} className={join(styles.nav, vertical && styles.vertical)}>
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
