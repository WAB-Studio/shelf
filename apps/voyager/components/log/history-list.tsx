"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import NextLink from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";

import { readWordStudy, type StudyRow } from "@/lib/log/summary";
import { countRecords, LOG_CLEARED_EVENT, LOG_FLUSHED_EVENT } from "@/lib/log/record";
import { filterStudyRows, rememberFilter } from "@/lib/log/study-filter";
import { SYNC_LANDED_EVENT } from "@/lib/sync/driver";
import {
  Box,
  Button,
  Flex,
  Grid,
  IconButton,
  Link,
  MetaLabel,
  Separator,
  Skeleton,
  TapTarget,
  Text,
  TextField,
} from "@/components/ui";

// Reachable through `useEffect` alone (module 25's own store, IndexedDB),
// never through `lib/dictionary` or `lib/sync` — this screen answers RNL-08
// with no import, not with a check.

type ListState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "ready"; rows: StudyRow[]; totalLookups: number; totalWords: number }
  | { kind: "failed" };

const StudyRowItem = memo(function StudyRowItem({ row, first }: { row: StudyRow; first: boolean }) {
  const t = useTranslations("log");
  const lead = row.forms[0];
  // A phrase or a miss reached no lemma: it keeps the text as typed.
  const lemmaless = row.lastOutcome === "translated" || row.lastOutcome === "unlisted";
  // A lone form that is the key says nothing the title does not.
  const formsLine =
    lead === undefined || (row.forms.length === 1 && lead.text === row.key)
      ? null
      : row.forms.map((form) => form.text).join(", ");
  return (
    <Flex direction="column" gap="3">
      {!first && <Separator size="4" />}
      <Link asChild underline="none">
        <NextLink href={`/registro/${encodeURIComponent(row.key)}`} prefetch={false}>
          <TapTarget size={44} direction="column" align="stretch" width="100%">
            {/* `minmax(0, 1fr) auto` on the phone stacks the translation under
              the word; the desktop's third track puts word, translation and
              count on one row (RL-56's board). `gridColumn`/`gridRow` move
              each cell between the two shapes. The `minmax(0, …)` is
              written out, not left to Radix's own `columns` shorthand:
              `grid.props.js`'s `parseValue` only rewrites a bare digit
              count into `repeat(n, minmax(0, 1fr))` — a literal string like
              `"1fr auto"` passes through unchanged, so a `1fr` track alone
              never gets a zero floor.

              A truncated word still needs a second guard past that: CSS
              blockifies a grid item's own display, but not a *grandchild*
              that only sits inside a plain `Box`, so `Text truncate` stayed
              `display: inline` — where `overflow: hidden` does not clip —
              and rendered at its full, un-clamped width regardless of the
              column underneath it. Making the wrapper a `Flex` (a
              container of its own) blockifies the `Text` it holds exactly
              the way module 3's original code had it as the grid item
              directly (docs/voyager/DESIGN.md "What the data forces"). */}
            <Grid
              columns={{ initial: "minmax(0, 1fr) auto", md: "minmax(0, 1fr) minmax(0, 1fr) auto" }}
              gap="3"
              align="center"
            >
              <Flex gridColumn="1" gridRow="1" minWidth="0" overflow="hidden">
                <Text serif truncate english>
                  {lemmaless ? row.display : row.key}
                </Text>
              </Flex>
              <Flex
                gridColumn={{ initial: "1", md: "2" }}
                gridRow={{ initial: "2", md: "1" }}
                minWidth="0"
                overflow="hidden"
                direction="column"
              >
                {row.lastTranslation !== null ? (
                  <Text variant="translation" muted truncate>
                    {row.lastTranslation}
                  </Text>
                ) : row.lastOutcome === "unlisted" ? (
                  <Text variant="translation" muted truncate>
                    {t("study.noResult")}
                  </Text>
                ) : null}
                {formsLine !== null && (
                  <Text size="2" muted truncate>
                    {formsLine}
                  </Text>
                )}
              </Flex>
              <Box gridColumn={{ initial: "2", md: "3" }} gridRow="1" justifySelf="end">
                <MetaLabel>{row.count}</MetaLabel>
              </Box>
            </Grid>
          </TapTarget>
        </NextLink>
      </Link>
    </Flex>
  );
});

function StudySkeleton() {
  const t = useTranslations("log");
  return (
    <Flex direction="column" gap="4">
      {Array.from({ length: 4 }, (_, index) => (
        <Flex direction="column" gap="2" key={index}>
          <Skeleton>
            <Text size="5" serif>
              {t("study.skeletonWord")}
            </Text>
          </Skeleton>
          <Skeleton>
            <Text variant="translation">{t("study.skeletonTranslation")}</Text>
          </Skeleton>
        </Flex>
      ))}
    </Flex>
  );
}

export function HistoryList() {
  const t = useTranslations("log");
  const router = useRouter();
  // The text lives in the URL so the back link from a word finds it; the
  // state below is what paints, so a key never waits on the router.
  const initialFilter = useSearchParams().get("filtro") ?? "";
  const [query, setQuery] = useState(initialFilter);
  // A page opened with the filter already in the address must also feed the back link.
  useEffect(() => rememberFilter(initialFilter), [initialFilter]);
  const [state, setState] = useState<ListState>({ kind: "loading" });
  // Bumped by the failed state's own retry, since the read runs in an
  // effect and a click cannot call it directly.
  const [attempt, setAttempt] = useState(0);
  // Every read this component starts bumps this, so a reply superseded by
  // a newer one — the flush event firing mid-read — never overwrites it.
  const requestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // Set while a `read` is between its call and its `finally`, so a flush
    // that lands mid-read never opens a second cursor over the same store —
    // the previous guard only picked which reply painted, not which ones
    // ran, and two full passes over 10k+ rows both cost the main thread at
    // once. A flush during that window queues one rerun instead.
    let reading = false;
    let rerunQueued = false;

    function read(): void {
      const requestId = ++requestIdRef.current;
      reading = true;
      Promise.all([readWordStudy(), countRecords()])
        .then(([study, totalLookups]) => {
          if (cancelled || requestIdRef.current !== requestId) return;
          setState(
            study.rows.length === 0
              ? { kind: "empty" }
              : { kind: "ready", rows: study.rows, totalLookups, totalWords: study.total },
          );
        })
        .catch(() => {
          if (!cancelled && requestIdRef.current === requestId) setState({ kind: "failed" });
        })
        .finally(() => {
          reading = false;
          if (!cancelled && rerunQueued) {
            rerunQueued = false;
            read();
          }
        });
    }

    function onChange(): void {
      // Already mid-read: its own reply is what's stale, not this event —
      // one rerun once it lands covers whatever the flush or the clear did.
      if (reading) {
        rerunQueued = true;
        return;
      }
      read();
    }

    read();
    // RL-55's row can still be in flight to IndexedDB when this screen
    // mounts: the search that motivated the trip only settles in
    // `record.ts` once the reader leaves `/`, and that write is async even
    // once forced. This rereads the moment it lands, instead of waiting on
    // a reload — `read` only ever calls `setState` with a finished answer,
    // so an already-populated list never drops back to the skeleton.
    // `LOG_CLEARED_EVENT` rereads the same way: a wipe empties the store
    // this effect never touches directly, so it needs the same nudge a
    // landed row does to drop back to the empty state.
    window.addEventListener(LOG_FLUSHED_EVENT, onChange);
    window.addEventListener(LOG_CLEARED_EVENT, onChange);
    // A pull that landed rows from another device changes the store the same way.
    window.addEventListener(SYNC_LANDED_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(LOG_FLUSHED_EVENT, onChange);
      window.removeEventListener(LOG_CLEARED_EVENT, onChange);
      window.removeEventListener(SYNC_LANDED_EVENT, onChange);
    };
  }, [attempt]);

  const readyRows = state.kind === "ready" ? state.rows : null;
  const visible = useMemo(
    () => (readyRows === null ? [] : filterStudyRows(readyRows, query)),
    [readyRows, query],
  );

  if (state.kind === "loading") {
    return <StudySkeleton />;
  }

  if (state.kind === "empty") {
    return (
      <Flex direction="column" gap="3" align="start">
        <Text size="4" weight="bold">
          {t("study.emptyTitle")}
        </Text>
        <Text size="2" muted>
          {t("study.emptyBody")}
        </Text>
        <Button size="2" tap onClick={() => router.push("/")}>
          {t("study.emptyAction")}
        </Button>
      </Flex>
    );
  }

  if (state.kind === "failed") {
    // No red in this palette (docs/voyager/DESIGN.md "Failure"): a hairline
    // sets the break off, full-weight ink says it, the accent lives in
    // retry — the same treatment as install-status.tsx and phrase-answer.tsx.
    return (
      <Flex direction="column" gap="3" align="start">
        <Separator size="4" />
        <Text size="2" weight="bold">
          {t("study.failedTitle")}
        </Text>
        <Text size="2" muted>
          {t("study.failedBody")}
        </Text>
        <Button
          size="2"
          tap
          onClick={() => {
            setState({ kind: "loading" });
            setAttempt((current) => current + 1);
          }}
        >
          {t("study.failedAction")}
        </Button>
      </Flex>
    );
  }

  const filtering = query.trim() !== "";

  function change(text: string): void {
    setQuery(text);
    rememberFilter(text);
    // The router's own `replace` fetches the page again, which a reader
    // offline cannot; `history.replaceState` only rewrites the address.
    window.history.replaceState(
      null,
      "",
      text === "" ? "/registro" : `/registro?filtro=${encodeURIComponent(text)}`,
    );
  }

  return (
    <Flex direction="column" gap="5">
      <Flex direction="column" gap="3">
        <TextField.Root
          size="3"
          tap
          value={query}
          onChange={(event) => change(event.target.value)}
          placeholder={t("study.filterLabel")}
          aria-label={t("study.filterLabel")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        >
          {query.length > 0 && (
            <TextField.Slot side="right">
              <IconButton
                type="button"
                size="2"
                variant="ghost"
                color="gray"
                tap
                aria-label={t("study.filterClear")}
                onClick={() => change("")}
              >
                <X size={16} />
              </IconButton>
            </TextField.Slot>
          )}
        </TextField.Root>
        {filtering && visible.length > 0 && (
          <Text size="2" muted>
            {t("study.filterCount", { shown: visible.length, total: state.totalWords })}
          </Text>
        )}
      </Flex>

      <Text size="2" muted>
        {t("study.header", { lookups: state.totalLookups, words: state.totalWords })}
      </Text>

      {visible.length === 0 ? (
        <Text size="2" muted>
          {t("study.filterNone", { query: query.trim() })}
        </Text>
      ) : (
        <Flex direction="column" gap="3">
          {visible.map((row, index) => (
            <StudyRowItem key={row.key} row={row} first={index === 0} />
          ))}
        </Flex>
      )}
    </Flex>
  );
}
