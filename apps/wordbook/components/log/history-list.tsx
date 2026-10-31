"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import NextLink from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { readWordStudy, type StudyRow } from "@/lib/log/summary";
import { countRecords, LOG_CLEARED_EVENT, LOG_FLUSHED_EVENT, readSyncState } from "@/lib/log/record";
import { deleteStudyGroup, LOG_DELETED_EVENT } from "@/lib/log/delete";
import { countKind } from "@/lib/log/outcome";
import { groupByDay, newestRows } from "@/lib/log/diary";
import { filterStudyRows, rememberFilter } from "@/lib/log/study-filter";
import { splitTranslations } from "@/lib/log/translation-line";
import { SYNC_LANDED_EVENT } from "@/lib/sync/driver";
import {
  Button,
  Card,
  Figure,
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

// The one row whose ✕ was pressed: a second row's ✕ replaces it, so two
// questions are never open at once (`RegistroBorrarFilaConfirmar`).
// `local`: the copy is off, so the delete reaches this device alone (RNL-11).
// `note`: signed out with its reader kept, so the account deletes on return.
type DeleteTarget = { key: string; phase: "asking" | "deleting" | "failed"; local: boolean; note: boolean };

type RowActions = {
  ask: (key: string) => void;
  keep: () => void;
  remove: (key: string) => void;
};

// The rows drawn at first and per «Ver más»: 400 rows at once is a 37,000px page.
const PAGE_ROWS = 50;

const StudyRowItem = memo(function StudyRowItem({
  row,
  phase,
  local,
  note,
  actions,
}: {
  row: StudyRow;
  // Undefined on every row but the target, so pressing one ✕ re-renders one row.
  phase: DeleteTarget["phase"] | undefined;
  local: boolean;
  note: boolean;
  actions: RowActions;
}) {
  const t = useTranslations("log");
  const lead = row.forms[0];
  // A phrase or a miss reached no lemma: it keeps the text as typed.
  const waiting = row.pending === true;
  const lemmaless = waiting || row.lastOutcome === "translated" || row.lastOutcome === "unlisted";
  const word = lemmaless ? row.display : row.key;
  const deleting = phase === "deleting";
  // A lone form that is the key says nothing the title does not.
  const formsLine =
    lead === undefined || (row.forms.length === 1 && lead.text === row.key)
      ? null
      : row.forms.map((form) => form.text).join(", ");
  const inline = waiting
    ? null
    : row.lastTranslation !== null
      ? splitTranslations(row.lastTranslation)[0]
      : row.lastOutcome === "unlisted"
        ? t("study.noResult")
        : null;
  // A row with nothing under its line is the line alone, 44px; one that says more pads itself.
  const extended = waiting || formsLine !== null || phase !== undefined;
  return (
    // The row is a card of one line: the word, its main translation and its count are the link; the ✕ sits
    // in a track of its own beside it, so a tap on it can never navigate (`RegistroBorrarFila`).
    <Card padding="none">
      <Grid columns="minmax(0, 1fr) 44px" gapY="1" align="center" px="3" py={extended ? "2" : "0"}>
        <Link asChild underline="none" ink>
          <NextLink href={`/registro/${encodeURIComponent(row.key)}`} prefetch={false}>
            <TapTarget width="100%" align="center" gap="3">
              {/* `Text truncate` needs a flex container of its own to clip (docs/wordbook/DESIGN.md
                  "What the data forces"). */}
              <Flex minWidth="0" maxWidth="60%" overflow="hidden">
                <Text size="5" weight="bold" serif truncate english>
                  {word}
                </Text>
              </Flex>
              <Flex minWidth="0" flexGrow="1" overflow="hidden">
                {inline !== null && (
                  <Text variant="translation" muted truncate>
                    {inline}
                  </Text>
                )}
              </Flex>
              <MetaLabel nowrap aria-label={t("study.rowCountLabel", { count: row.count })}>
                {t("study.rowCount", { count: row.count })}
              </MetaLabel>
            </TapTarget>
          </NextLink>
        </Link>
      {phase === undefined && (
        // A ghost's negative margins stretch it past a grid track it fills;
        // centred in a cell of its own it keeps to 44px, clear of the link.
        <Flex justify="center">
          <IconButton
            type="button"
            size="2"
            variant="ghost"
            color="gray"
            quiet
            aria-label={t("study.deleteRow", { word })}
            onClick={() => actions.ask(row.key)}
          >
            <X size={16} />
          </IconButton>
        </Flex>
      )}

      {(waiting || formsLine !== null) && (
        <Flex gridColumn="1 / -1" direction="column" gap="1" minWidth="0">
          {waiting ? (
            <>
              <Text size="2" muted="quietest">
                {t("study.pendingWaiting")}
              </Text>
              <Text size="2" muted="quietest">
                {t(row.lastOutcome === "untranslated" ? "study.pendingPhrase" : "study.pendingWord")}
              </Text>
            </>
          ) : (
            <Text size="2" muted truncate>
              {formsLine}
            </Text>
          )}
        </Flex>
      )}

      {(phase === "asking" || phase === "deleting") && (
        // The order and weights of `RegistroVaciarConfirmar`: the accent on
        // the safe exit, the destructive one a grey link after it.
        <Flex gridColumn="1 / -1" direction="column" gap="3" align="start">
          <Flex direction="column" gap="1">
            <Text variant="breakTitle">{t("study.deleteConfirmTitle", { word })}</Text>
            <Text variant="breakBody" muted>
              {t(local ? "study.deleteConfirmBodyLocal" : "study.deleteConfirmBody", { count: row.count })}
            </Text>
            {note && (
              <Text variant="breakBody" muted>
                {t("study.deleteConfirmLocalNote")}
              </Text>
            )}
          </Flex>
          <Flex gap="4" align="center" wrap="wrap">
            <Button size="3" disabled={deleting} onClick={actions.keep}>
              {t("study.deleteKeep")}
            </Button>
            <Link asChild underline="always" muted>
              <button type="button" disabled={deleting} onClick={() => actions.remove(row.key)}>
                <TapTarget align="center" px="1">
                  {deleting ? t("study.deleting") : t("study.deleteConfirm")}
                </TapTarget>
              </button>
            </Link>
          </Flex>
        </Flex>
      )}

      {phase === "failed" && (
        // `## Failure`: a hairline, the line in full ink, the accent on the
        // retry. The transaction aborted whole, so the row above is intact.
        <Flex gridColumn="1 / -1" direction="column" gap="3" align="start">
          <Separator size="4" />
          <Flex direction="column" gap="1">
            <Text variant="breakTitle" role="alert">
              {t("study.deleteFailedTitle", { word })}
            </Text>
            <Text variant="breakBody" muted>
              {t("study.deleteFailedBody", { count: row.count })}
            </Text>
          </Flex>
          <Flex gap="4" align="center" wrap="wrap">
            <Button size="3" onClick={() => actions.remove(row.key)}>
              {t("retry")}
            </Button>
            <Link asChild underline="always" muted>
              <button type="button" onClick={actions.keep}>
                <TapTarget align="center" px="1">
                  {t("study.deleteKeep")}
                </TapTarget>
              </button>
            </Link>
          </Flex>
        </Flex>
      )}
      </Grid>
    </Card>
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
  const [shownRows, setShownRows] = useState(PAGE_ROWS);
  // Bumped by the failed state's own retry, since the read runs in an
  // effect and a click cannot call it directly.
  const [attempt, setAttempt] = useState(0);
  // Every read this component starts bumps this, so a reply superseded by
  // a newer one — the flush event firing mid-read — never overwrites it.
  const requestIdRef = useRef(0);
  const filterField = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<DeleteTarget | null>(null);
  const localRef = useRef(true);
  const noteRef = useRef(false);
  const askIdRef = useRef(0);
  // Holds a key from its first «Borrar» to its settle: two taps inside one
  // task both run before `disabled` paints, and only the first may reach
  // IndexedDB.
  const inFlightRef = useRef(new Set<string>());

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
          // A deleted row keeps «Borrando…» until this reread drops it, so its
          // ✕ never flashes back for the frame in between.
          setTarget((current) =>
            current !== null && !study.rows.some((row) => row.key === current.key) ? null : current,
          );
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
    // A row's ✕ deleted its group (`deleteStudyGroup`).
    window.addEventListener(LOG_DELETED_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(LOG_FLUSHED_EVENT, onChange);
      window.removeEventListener(LOG_CLEARED_EVENT, onChange);
      window.removeEventListener(SYNC_LANDED_EVENT, onChange);
      window.removeEventListener(LOG_DELETED_EVENT, onChange);
    };
  }, [attempt]);

  const readyRows = state.kind === "ready" ? state.rows : null;
  const visible = useMemo(
    () => (readyRows === null ? [] : filterStudyRows(readyRows, query)),
    [readyRows, query],
  );

  const format = useFormatter();
  // The day «today» means is the one the screen opened on.
  const [openedAt] = useState(() => Date.now());
  const days = useMemo(() => groupByDay(newestRows(visible, shownRows), openedAt), [visible, shownRows, openedAt]);

  const remove = useCallback(async (key: string): Promise<void> => {
    if (inFlightRef.current.has(key)) return;
    inFlightRef.current.add(key);
    setTarget({ key, phase: "deleting", local: localRef.current, note: noteRef.current });
    try {
      const { deleted } = await deleteStudyGroup(key);
      // Nothing matched: no reread will drop the row, so nothing clears it.
      if (deleted === 0) setTarget((current) => (current?.key === key ? null : current));
    } catch {
      // Shown even over another row's question: a refusal nobody sees reads as done.
      setTarget({ key, phase: "failed", local: localRef.current, note: false });
    } finally {
      inFlightRef.current.delete(key);
    }
  }, []);
  const actions = useMemo<RowActions>(
    () => ({
      ask: (key) => {
        const askId = ++askIdRef.current;
        // Read once as the question opens; the newest ✕ wins a slow read.
        void readSyncState().then((sync) => {
          if (askIdRef.current !== askId) return;
          localRef.current = !(sync.enabled && sync.readerId !== null && !sync.retired);
          noteRef.current = localRef.current && sync.readerId !== null && !sync.retired;
          setTarget({ key, phase: "asking", local: localRef.current, note: noteRef.current });
        });
      },
      keep: () => {
        askIdRef.current++;
        setTarget(null);
      },
      remove: (key) => void remove(key),
    }),
    [remove],
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
        <Button size="2" onClick={() => router.push("/")}>
          {t("study.emptyAction")}
        </Button>
      </Flex>
    );
  }

  if (state.kind === "failed") {
    // No red in this palette (docs/wordbook/DESIGN.md "Failure"): a hairline
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
  const kind = countKind(state.rows);

  function change(text: string): void {
    setQuery(text);
    setShownRows(PAGE_ROWS);
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
          ref={filterField}
          size="3"
          value={query}
          onChange={(event) => change(event.target.value)}
          label={t("study.filterLabel")}
          placeholder={t("study.filterPlaceholder")}
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
                aria-label={t("study.filterClear")}
                onClick={() => {
                  change("");
                  filterField.current?.focus();
                }}
              >
                <X size={16} />
              </IconButton>
            </TextField.Slot>
          )}
        </TextField.Root>
        {filtering && visible.length > 0 && (
          <Text size="2" muted>
            {t("study.filterCount", { shown: visible.length, total: state.totalWords, kind })}
          </Text>
        )}
      </Flex>

      <Flex gap="6" wrap="wrap">
        <Figure value={state.totalLookups} label={t("study.figureLookups", { count: state.totalLookups })} />
        <Figure value={state.totalWords} label={t("study.figureWords", { count: state.totalWords, kind })} />
      </Flex>

      {visible.length === 0 ? (
        <Text size="2" muted>
          {t("study.filterNone", { query: query.trim(), kind })}
        </Text>
      ) : (
        <Flex direction="column" gap="4">
          {/* A diary: the days newest first, each with its rows in compact cards. */}
          {days.map((day) => (
            <Flex key={`${day.when}-${day.at}`} direction="column" gap="3">
              <MetaLabel>
                {day.when === "today"
                  ? t("study.dayToday", { count: day.rows.length })
                  : day.when === "yesterday"
                    ? t("study.dayYesterday", { count: day.rows.length })
                    : t("study.dayOther", {
                        count: day.rows.length,
                        date: format.dateTime(day.at, { weekday: "long", day: "numeric", month: "short" }),
                      })}
              </MetaLabel>
              <Grid columns={{ initial: "1", lg: "2", xl: "3" }} gap="3" align="start">
                {day.rows.map((row) => (
                  <StudyRowItem
                    key={row.key}
                    row={row}
                    phase={target?.key === row.key ? target.phase : undefined}
                    local={target?.key === row.key && target.local}
                    note={target?.key === row.key && target.note}
                    actions={actions}
                  />
                ))}
              </Grid>
            </Flex>
          ))}
          {visible.length > shownRows && (
            <Flex justify="center">
              <Button size="3" variant="soft" onClick={() => setShownRows(shownRows + PAGE_ROWS)}>
                {t("study.more", { count: visible.length - shownRows })}
              </Button>
            </Flex>
          )}
        </Flex>
      )}
    </Flex>
  );
}
