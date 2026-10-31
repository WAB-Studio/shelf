"use client";

import { useEffect, useSyncExternalStore } from "react";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Heading, Link } from "@radix-ui/themes";


import { QUERY_COMMITTED_EVENT, readNavQuery, writeNavQuery } from "@/lib/nav/query-storage";

import { TapTarget } from "./tap-target";
import { Wordmark } from "./wordmark";
import { ThemeChoice } from "./theme-choice";
import styles from "./bottom-nav.module.css";

// The query name `search-screen.tsx` writes to the address bar on settle.
const QUERY_PARAM = "q";

function readAddressBarQuery(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(QUERY_PARAM) ?? "";
}

function searchHref(query: string): string {
  return query ? `/?${QUERY_PARAM}=${encodeURIComponent(query)}` : "/";
}

// The address bar's query changes under a mounted bar when the search screen writes it
// (`history.pushState` tells no one) or the browser walks its history.
function subscribeToQuery(onChange: () => void): () => void {
  window.addEventListener(QUERY_COMMITTED_EVENT, onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener(QUERY_COMMITTED_EVENT, onChange);
    window.removeEventListener("popstate", onChange);
  };
}

function getServerQuery(): string {
  return "";
}

// docs/wordbook/DESIGN.md "Viewport": stroke-width 1.75, round caps and
// joins, fill none, 20px — read from the published boards, not guessed.
const GLYPH_PROPS = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function SearchGlyph() {
  return (
    <svg {...GLYPH_PROPS} aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

function LogGlyph() {
  return (
    <svg {...GLYPH_PROPS} aria-hidden="true">
      <path d="M5 6h14M5 12h14M5 18h9" />
    </svg>
  );
}

function AccountGlyph() {
  return (
    <svg {...GLYPH_PROPS} aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20c1.4-4 4-6 7.5-6s6.1 2 7.5 6" />
    </svg>
  );
}

const GLYPHS = {
  search: SearchGlyph,
  log: LogGlyph,
  account: AccountGlyph,
} as const;

// `route` is what marks a destination current; `search`'s actual `href`
// gains the query on top of it, the other two never do.
const items = [
  { route: "/", key: "search" } as const,
  { route: "/registro", key: "log" } as const,
  { route: "/cuenta", key: "account" } as const,
];

// docs/wordbook/DESIGN.md "Viewport": the same three sections the bar has
// always carried (`## Settled`: it shipped with two, Cuenta joined with the
// account slice), now also the desktop sidebar's three destinations — one
// `<nav>`, one CSS media query at 1024px, never a second tree mounted
// alongside it. Never an action, a filter or a count: `Fuente` rides as a
// link on the screens that carry the box, not a fourth item here. The
// sidebar's foot carries the theme control (RNL-07); on the phone it lives in
// /cuenta, since the bar has no foot.
export function BottomNav() {
  const pathname = usePathname();
  const t = useTranslations("nav");
  const tMeta = useTranslations("metadata");
  // The address bar's own `q` on `/`, what a prior mount remembered
  // anywhere else. `getServerQuery` answers "" for the hydration pass, so
  // the server-rendered `href="/"` never mismatches the client's first
  // paint — the real value lands one commit later, the way sense-list.tsx's
  // `speechSupported` already does.
  const query = useSyncExternalStore(
    subscribeToQuery,
    () => (pathname === "/" ? readAddressBarQuery() : readNavQuery()),
    getServerQuery,
  );

  // The one-way sync onto the external store `useSyncExternalStore` only
  // reads: leaving `/` with a query already committed must still find it
  // from `/registro` or `/cuenta`, which never carry `q` themselves.
  useEffect(() => {
    if (pathname === "/") writeNavQuery(query);
  }, [pathname, query]);

  // Chrome on Android reads no `interactiveWidget`: an open keyboard
  // shrinks `visualViewport` alone, and the fixed bar — sized against the
  // layout viewport — sits under it. The gap between the two is the
  // keyboard's own height; `bottom-nav.module.css` adds it to `bottom` so
  // the bar rides above the keyboard instead. Absent `visualViewport`
  // itself, nothing here runs and the CSS variable stays unset.
  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) return;

    function writeKeyboardInset(): void {
      const inset = Math.max(0, window.innerHeight - visualViewport!.height - visualViewport!.offsetTop);
      document.documentElement.style.setProperty("--rl-keyboard-inset", `${inset}px`);
    }

    writeKeyboardInset();
    visualViewport.addEventListener("resize", writeKeyboardInset);
    visualViewport.addEventListener("scroll", writeKeyboardInset);
    return () => {
      visualViewport.removeEventListener("resize", writeKeyboardInset);
      visualViewport.removeEventListener("scroll", writeKeyboardInset);
    };
  }, []);

  return (
    <nav className={styles.nav} aria-label={t("label")}>
      <Heading as="h2" className={styles.title} aria-label={tMeta("title")}>
        <Wordmark>{t.rich("brand", { mark: (chunks) => <mark>{chunks}</mark> })}</Wordmark>
      </Heading>
      {items.map(({ route, key }) => {
        const selected = pathname === route;
        const Glyph = GLYPHS[key];
        const href = key === "search" ? searchHref(query) : route;
        return (
          <Link
            key={route}
            asChild
            underline="none"
            className={`${styles.item} ${selected ? styles.selected : styles.unselected}`}
          >
            {/* The search link's address changes with every query typed; prefetching each one would ask the
                  server on a keystroke's settle. */}
            <NextLink href={href} prefetch={key === "search" ? false : undefined} aria-current={selected ? "page" : undefined}>
              {/* Radix's own `md` breakpoint is 1024px (`--md` in
                  breakpoints.css), the same one bottom-nav.module.css
                  switches on: icon above label on the bar, icon beside
                  label on the sidebar, with no primitive to patch. */}
              <TapTarget
                direction={{ initial: "column", md: "row" }}
                align="center"
                justify="center"
                gap="1"
              >
                <Glyph />
                <span className={styles.label}>{t(key)}</span>
              </TapTarget>
            </NextLink>
          </Link>
        );
      })}
      {/* flex-grow pushes the theme control to the sidebar's foot; both draw
          nothing on the bar, where they collapse to zero width. */}
      <div className={styles.spacer} aria-hidden="true" />
      <div className={styles.foot}>
        <ThemeChoice />
      </div>
    </nav>
  );
}
