import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import styles from "./ui.module.css";

const join = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

// `wide` opens the page to 1200 for the screens that split into a block and its rows.
export function Page({ wide, children }: { wide?: boolean; children: ReactNode }) {
  return <main className={join(styles.page, wide && styles.pageWide)}>{children}</main>;
}

// A form's column inside the wide page: the header keeps its place from one screen to the next.
export function Narrow({ children }: { children: ReactNode }) {
  return <div className={styles.narrow}>{children}</div>;
}

// The brand block on top, wide; the cards of the day in a mosaic under it.
export function Mosaic({ children }: { children: ReactNode }) {
  return <div className={styles.mosaic}>{children}</div>;
}

// One card of the mosaic: its title in the display face, its total at the right. `full` takes a whole row; `lead`
// takes one only where the mosaic has two columns, so the longest list is never squeezed.
export function Tile({ title, figure, full, lead, children }: { title: ReactNode; figure?: ReactNode; full?: boolean; lead?: boolean; children: ReactNode }) {
  return (
    <section className={join(styles.tile, full && styles.tileFull, lead && styles.tileLead)}>
      <div className={styles.tileHead}>
        <h2 className={styles.tileTitle}>{title}</h2>
        {figure === undefined ? null : <Text mono>{figure}</Text>}
      </div>
      {children}
    </section>
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

export type Tone = "code" | "browser" | "comms" | "leisure" | "system" | "other" | "claude" | "claudeWeb" | "claudeApp";

type MeterSize = "large" | "default" | "compact";

// A name and its figure over the bar under them, 48 tall at least (DESIGN «Hoy»). A long name
// truncates; the figure never wraps.
export function Meter({ name, figure, share, label, size = "default", tone }: { name: ReactNode; figure: ReactNode; share: number; label: string; size?: MeterSize; tone?: Tone }) {
  return (
    <div className={join(styles.stack, styles.gap1, styles.meter, size === "large" && styles.meterLarge, size === "compact" && styles.meterCompact)}>
      <div className={styles.line}>
        <Text truncate>{name}</Text>
        <Text mono>{figure}</Text>
      </div>
      <Bar share={share} label={label} tone={tone} />
    </div>
  );
}

// A row that opens onto its detail: the native <details>, so it works without a script and by keyboard.
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

// The brand block: the one dark block on the main screen.
export function Hero({ children }: { children: ReactNode }) {
  return <section className={styles.hero}>{children}</section>;
}

// The block's parts side by side where they fit, stacked where they do not.
export function HeroColumns({ children }: { children: ReactNode }) {
  return <div className={styles.heroColumns}>{children}</div>;
}

export function Title({ small, children }: { small?: boolean; children: ReactNode }) {
  return <h1 className={join(styles.title, small && styles.titleSmall)}>{children}</h1>;
}

// A time set big: its figures large, its units small. `mark` sets it on a cyan tint with a cyan edge.
export function Figure({ parts, mark }: { parts: { value: string; unit: string }[]; mark?: boolean }) {
  return (
    <p className={join(styles.figure, mark && styles.mark)}>
      {parts.map((part) => (
        <span key={part.unit}>
          {part.value}
          <span className={styles.unit}> {part.unit}</span>
        </span>
      ))}
    </p>
  );
}

type TextVariant = "total" | "row" | "meta";

export function Text({ variant = "row", mono, mark, truncate, as = "span", children }: { variant?: TextVariant; mono?: boolean; mark?: boolean; truncate?: boolean; as?: "span" | "p"; children: ReactNode }) {
  const Tag = as;
  // A cut text carries its whole self as a hover and long-press title.
  const title = truncate && typeof children === "string" ? children : undefined;
  return <Tag title={title} className={join(styles[variant], mono && styles.mono, mark && styles.mark, !mono && styles.name, truncate && styles.truncate)}>{children}</Tag>;
}

// Inside the brand block: a small label over a value.
export function Cards({ children }: { children: ReactNode }) {
  return <div className={styles.cards}>{children}</div>;
}

export function Card({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.card}>
      <Text variant="meta">{label}</Text>
      {children}
    </div>
  );
}

// «13 h» as «13» over «h», so two neighbours never read as one run of figures.
function FigureParts({ text }: { text: string }) {
  const at = text.indexOf(" ");
  return at < 0 ? text : <><span>{text.slice(0, at)}</span><span className={styles.dayUnit}>{text.slice(at + 1)}</span></>;
}

export type CompositionPart = { key: string; tone: Tone; seconds: number; name: string; figure: string };

// A whole in parts on the brand block: one stacked bar and, under it, each part's name and figure in words, so no
// part is told by colour alone. `thin` leaves the legend to the text around it.
export function Composition({ parts, label, thin }: { parts: CompositionPart[]; label: string; thin?: boolean }) {
  const total = Math.max(1, parts.reduce((sum, part) => sum + part.seconds, 0));
  return (
    <div className={styles.composition}>
      <div className={join(styles.stacked, thin && styles.stackedThin)} role="img" aria-label={label}>
        {parts.map((part) => (
          <div key={part.key} className={join(styles.part, styles[`tone_${part.tone}`])} style={{ flexGrow: part.seconds / total }} />
        ))}
      </div>
      {thin ? null : (
        <ul className={styles.legend}>
          {parts.map((part) => (
            <li key={part.key} className={styles[`tone_${part.tone}`]}>
              <span className={styles.swatch} aria-hidden="true" />
              <Text truncate>{part.name}</Text>
              <Text mono>{part.figure}</Text>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export type HeatmapColumn = { key: string; label: string; href?: string; future?: boolean };
export type HeatmapRow = { key: string; name: string; tone: Tone; total: string; cells: { figure: { wide: string; narrow: string } | null; level: number; label: string }[] };

// A grid of rows by days, a cell tinted by its level and always carrying its figure (a level only helps the eye find it).
export function Heatmap({ columns, rows, label }: { columns: HeatmapColumn[]; rows: HeatmapRow[]; label: string }) {
  return (
    <table className={styles.heat} aria-label={label}>
      <thead>
        <tr>
          <th scope="col" className={styles.heatName} />
          {columns.map((column) => (
            <th key={column.key} scope="col" className={join(styles.heatHead, column.future && styles.dayFuture)}>
              {column.href === undefined || column.future ? column.label : <Link href={column.href} className={styles.heatLink}>{column.label}</Link>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className={styles[`tone_${row.tone}`]}>
            <th scope="row" className={styles.heatName} title={`${row.name}: ${row.total}`}>
              <Text truncate>{row.name}</Text>
            </th>
            {row.cells.map((cell, index) => (
              <td key={columns[index].key} className={join(styles.heatCell, styles.mono)} data-level={cell.level} aria-label={cell.label}>
                {cell.figure === null ? <span className={styles.heatNone}>—</span> : <><span className={styles.heatWide}>{cell.figure.wide}</span><span className={styles.heatNarrow}>{cell.figure.narrow}</span></>}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// `empty` is a day reached with no upload: it reads as a dashed tile and its number is struck by a dash, never colour alone.
export type StripEntry = { key: string; initial: string; number: number; description: string; href?: string; current: boolean; empty?: boolean };

// The days of one week as touchable tiles, the month named above them, ‹ › one day away and « » one week away.
type StripStep = { href: string; label: string };

function StripArrow({ step, glyph }: { step?: StripStep; glyph: string }) {
  return step === undefined ? <span className={styles.stripStep} /> : <Link href={step.href} className={styles.stripStep} aria-label={step.label}>{glyph}</Link>;
}

export function DayStrip({ label, days, weekPrev, dayPrev, dayNext, weekNext }: { label: string; days: StripEntry[]; weekPrev?: StripStep; dayPrev?: StripStep; dayNext?: StripStep; weekNext?: StripStep }) {
  return (
    <nav className={styles.strip} aria-label={label}>
      <div className={styles.stripHead}>
        <StripArrow step={weekPrev} glyph="«" />
        <StripArrow step={dayPrev} glyph="‹" />
        <span className={styles.stripLabel}>{label}</span>
        <StripArrow step={dayNext} glyph="›" />
        <StripArrow step={weekNext} glyph="»" />
      </div>
      <div className={styles.stripDays}>
        {days.map((one) => {
          const inside = (
            <>
              <span className={styles.stripInitial}>{one.initial}</span>
              <span className={styles.mono}>{one.number}</span>
              {one.empty ? <span className={styles.stripNone} aria-hidden="true">—</span> : null}
            </>
          );
          return one.href === undefined ? (
            <span key={one.key} className={join(styles.stripDay, styles.stripOff)} aria-hidden="true">{inside}</span>
          ) : (
            <Link key={one.key} href={one.href} className={join(styles.stripDay, one.current && styles.stripCurrent, one.empty && styles.stripEmpty)} aria-label={one.description} aria-current={one.current ? "date" : undefined}>{inside}</Link>
          );
        })}
      </div>
    </nav>
  );
}

export type DayColumn = { key: string; label: string; figure: string; share: number; future: boolean; description: string; href?: string };

// Seven vertical columns, one per day, for the brand block; a day not reached is dimmed and empty.
export function DayColumns({ days }: { days: DayColumn[] }) {
  return (
    <div className={styles.days}>
      {days.map((day) => {
        const column = (
          <>
            <div className={styles.dayTrack} role="img" aria-label={day.description}>
              <div className={styles.dayFill} style={{ height: day.share > 0 ? `max(4px, ${Math.min(1, day.share) * 100}%)` : "0" }} />
            </div>
            <span className={join(styles.dayFigure, styles.mono)}>
              {day.future ? "" : <FigureParts text={day.figure} />}
            </span>
            <span className={styles.dayLabel}>{day.label}</span>
          </>
        );
        // A day reached opens on its own screen; one not reached stays a plain column.
        return day.href === undefined || day.future ? (
          <div key={day.key} className={join(styles.day, day.future && styles.dayFuture)}>
            {column}
          </div>
        ) : (
          <Link key={day.key} href={day.href} className={join(styles.day, styles.dayLink)}>
            {column}
          </Link>
        );
      })}
    </div>
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

export function CodeBlock({ children }: { children: ReactNode }) {
  return <div className={styles.codeBlock}>{children}</div>;
}

export function Code({ children }: { children: ReactNode }) {
  return <pre className={styles.code}>{children}</pre>;
}
