import Link from "next/link";
import { ChevronLeft, MessageCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { IconButton } from "./button";
import { SectionLabel } from "./section-label";
import { Skeleton } from "./skeleton";
import { Text } from "./text";
import styles from "./screen-header.module.css";

// `ArmazonEncabezado.dc.html`: the one header every screen draws. The title is
// the page's only `h1`; the way back is a chevron and the place's name, 48px,
// its accessible name «Volver a {place}». Nothing in it is sticky.
export function ScreenHeader({
  title,
  back,
  eyebrow,
  eyebrowHref,
  eyebrowFill,
  controls,
  actions,
  meta,
  metaVariant = "meta",
  lead,
  chat = false,
}: {
  title: string;
  back?: { href: string; place: string };
  // A string is drawn in the one eyebrow style. A node is drawn as given.
  eyebrow?: ReactNode;
  // Makes a string eyebrow an accent link.
  eyebrowHref?: string;
  // Stretches a node eyebrow across the header, for one that carries a row of its own.
  eyebrowFill?: boolean;
  // A row on the eyebrow's line: the steps, the way back, the theme toggle.
  controls?: ReactNode;
  // Beside the title from 1024, under it below.
  actions?: ReactNode;
  // One line under the title: mono figures by default, the quiet sentence when it reads as one.
  meta?: ReactNode;
  metaVariant?: "meta" | "sentence";
  // A mono line in ink straight under the title, before `meta`; its `<strong>` is the part to read first.
  lead?: ReactNode;
  // Draws the way into /chat at the end of the controls line (`ChatEntrada`, RP-91).
  chat?: boolean;
  // The eyebrow or controls hold a row of steps; the entry still sits at the end of their line.
  steps?: boolean;
}) {
  const t = useTranslations("common");
  const tChat = useTranslations("chat");
  const chatLink = chat ? (
    <IconButton asChild tap={44} variant="ghost" className={styles.chat}>
      <Link href="/chat" aria-label={tChat("open")}>
        <MessageCircle size={22} strokeWidth={1.5} aria-hidden />
      </Link>
    </IconButton>
  ) : null;
  const eyebrowNode =
    typeof eyebrow !== "string" ? (
      eyebrow
    ) : !eyebrow ? null : eyebrowHref ? (
      <Link href={eyebrowHref} className={styles.eyebrowLink}>
        {eyebrow}
      </Link>
    ) : (
      <SectionLabel>{eyebrow}</SectionLabel>
    );
  // With a way back and no row for controls or an eyebrow, the entry shares the back's line.
  // The entry keeps one place on every screen: the end of the line over the title.
  const chatInTitle = false;
  const chatInBackRow = chat && !!back && !controls && !eyebrowNode;
  const backLink = back ? (
    <Link
      href={back.href}
      className={styles.back}
      aria-label={t("header.back", { place: back.place })}
    >
      <ChevronLeft size={16} strokeWidth={1.5} aria-hidden />
      <span>{back.place}</span>
    </Link>
  ) : null;

  return (
    <header className={styles.header}>
      {backLink && chatInBackRow ? (
        <div className={styles.backRow}>
          {backLink}
          {chatLink}
        </div>
      ) : (
        backLink
      )}
      {controls ? (
        <div className={styles.top}>
          {eyebrowNode ? <div className={styles.eyebrow}>{eyebrowNode}</div> : null}
          <div className={styles.controls}>{controls}</div>
          {chatInTitle ? null : chatLink}
        </div>
      ) : eyebrowNode ? (
        chat && !chatInTitle ? (
          <div className={styles.top}>
            <div className={eyebrowFill ? `${styles.eyebrow} ${styles.eyebrowFill}` : styles.eyebrow}>{eyebrowNode}</div>
            <div className={styles.controls} />
            {chatLink}
          </div>
        ) : (
          <div className={eyebrowFill ? `${styles.eyebrow} ${styles.eyebrowFill}` : styles.eyebrow}>{eyebrowNode}</div>
        )
      ) : chat && !back && !chatInTitle ? (
        <div className={styles.chatRow}>{chatLink}</div>
      ) : null}
      <div className={styles.line}>
        {chatInTitle ? (
          <div className={styles.titleRow}>
            <Text asChild variant="title">
              <h1 className={styles.title}>{title}</h1>
            </Text>
            {chatLink}
          </div>
        ) : (
          <Text asChild variant="title">
            <h1 className={styles.title}>{title}</h1>
          </Text>
        )}
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {lead ? (
        <Text as="p" variant="meta" tone="ink" className={styles.lead}>
          {lead}
        </Text>
      ) : null}
      {meta ? (
        <Text as="p" variant={metaVariant} tone="muted" className={styles.meta}>
          {meta}
        </Text>
      ) : null}
    </header>
  );
}

// The header while its screen loads: the way back and the title as blocks, in
// the header's own height, so the content does not jump when the real one lands.
export function ScreenHeaderSkeleton() {
  return (
    <header aria-hidden className={styles.header}>
      <span className={styles.backSkeleton}>
        <Skeleton shape="meta" />
      </span>
      <div className={styles.titleSkeleton}>
        <Skeleton shape="title" width="half" />
      </div>
    </header>
  );
}

// What a screen that has nothing to show says and offers
// (`ArmazonFallo.dc.html`, `ArmazonNoEncontrada.dc.html`): an optional line and
// its exits, stacked full width on the phone, a row capped at 560px from 1024.
export function ScreenExit({ message, children }: { message?: string; children: ReactNode }) {
  return (
    <div className={styles.exit}>
      {message ? (
        <Text as="p" tone="secondary">
          {message}
        </Text>
      ) : null}
      <div className={styles.exitActions}>{children}</div>
    </div>
  );
}
