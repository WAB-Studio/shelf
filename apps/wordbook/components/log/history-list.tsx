"use client";

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MoreHorizontal, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { readWordStudy, type StudyRow } from "@/lib/log/summary";
import { readSyncState } from "@/lib/log/record";
import { onRecordChanged } from "@/lib/log/record-changed";
import { deleteStudyGroup } from "@/lib/log/delete";
import { isPhraseRow } from "@/lib/log/outcome";
import { deviceZone, yearWhenDifferent } from "@/lib/format/zone";
import { groupByDay, newestRows } from "@/lib/log/diary";
import { filterStudyRows, rememberFilter } from "@/lib/log/study-filter";
import { splitTranslations } from "@/lib/log/translation-line";
import { readCardKeys } from "@/lib/review/store";
import {
  Box,
  Button,
  Flex,
  IconButton,
  Link,
  Menu,
  MetaLabel,
  Segments,
  Separator,
  Skeleton,
  Table,
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
  // `learning`: the keys the review holds a card for, read in the same round as the rows.
  | { kind: "ready"; rows: StudyRow[]; learning: ReadonlySet<string>; totalWords: number }
  | { kind: "failed" };

// The one row whose «Quitar del registro» was chosen: a second row's replaces it, so two
// questions are never open at once (`RegistroBorrarFilaConfirmar`).
// `local`: the copy is off, so the delete reaches this device alone (RNL-11).
// `note`: signed out with its reader kept, so the account deletes on return.
type DeleteTarget = { key: string; phase: "asking" | "deleting" | "failed"; local: boolean; note: boolean };

type RowActions = {
  ask: (key: string) => void;
  keep: () => void;
  remove: (key: string) => void;
};

type Segment = "all" | "learning" | "phrases";

// What each segment of the filter keeps: the counts on its labels and the rows it shows read the same map.
const SEGMENT_KEEPS: Record<Segment, (row: StudyRow, learning: ReadonlySet<string>) => boolean> = {
  all: () => true,
  learning: (row, learning) => learning.has(row.key),
  phrases: (row) => isPhraseRow(row),
};

// The rows drawn at first and per «Ver más»: 400 rows at once is a 37,000px page.
const PAGE_ROWS = 50;

// A Radix menu costs a render for every row drawn, fifty at a time and again on each keystroke of the
// filter; a row gets its menu when its button is first pressed, and that press opens it.
function RowMenu({ word, onRemove }: { word: string; onRemove: () => void }) {
  const t = useTranslations("log");
  const [armed, setArmed] = useState(false);
  const button = (
    <IconButton
      type="button"
      size="2"
      variant="ghost"
      color="gray"
      quiet
      aria-label={t("study.rowMenu", { word })}
      aria-haspopup="menu"
      onClick={armed ? undefined : () => setArmed(true)}
    >
      <MoreHorizontal size={18} />
    </IconButton>
  );
  if (!armed) return button;
  return (
    <Menu.Root defaultOpen>
      <Menu.Trigger>{button}</Menu.Trigger>
      <Menu.Content align="end">
        <Menu.Item onSelect={onRemove}>{t("study.removeRow")}</Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}

const StudyRowItem = memo(function StudyRowItem({
  row,
  learning,
  time,
  phase,
  local,
  note,
  actions,
}: {
  row: StudyRow;
  learning: boolean;
  time: string;
  // Undefined on every row but the target, so choosing one row's menu item re-renders one row.
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
  const hasExtra = waiting || formsLine !== null || phase !== undefined;
  return (
    <Table.Row
      extra={
        hasExtra && (
          <Flex direction="column" gap="3" align="start" pb="3" px={{ initial: "0", md: "4" }}>
            {waiting && (
              <Text size="2" muted="quietest">
                {t(row.lastOutcome === "untranslated" ? "study.pendingPhrase" : "study.pendingWord")}
              </Text>
            )}
            {!waiting && formsLine !== null && (
              <Text size="2" muted truncate>
                {formsLine}
              </Text>
            )}

            {(phase === "asking" || phase === "deleting") && (
              // The order and weights of `RegistroVaciarConfirmar`: the accent on
              // the safe exit, the destructive one a grey link after it.
              <>
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
              </>
            )}

            {phase === "failed" && (
              // `## Failure`: a hairline, the line in full ink, the accent on the
              // retry. The transaction aborted whole, so the row above is intact.
              <>
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
              </>
            )}
          </Flex>
        )
      }
    >
      <Table.Cell column="word">
        <Table.Cover href={`/registro/${encodeURIComponent(row.key)}`}>
          {/* `Text truncate` needs a block of its own to clip (docs/wordbook/DESIGN.md "What the data forces"). */}
          <Text as="div" size="5" weight="bold" serif truncate english>
            {word}
          </Text>
        </Table.Cover>
      </Table.Cell>
      <Table.Cell column="translation">
        {waiting ? (
          <Text as="div" size="3" muted="quietest" truncate>
            {t("study.pendingWaiting")}
          </Text>
        ) : (
          inline !== null && (
            <Text as="div" size="5" serif muted="secondary" truncate>
              {inline}
            </Text>
          )
        )}
      </Table.Cell>
      <Table.Cell column="state">
        {learning ? (
          <Text size="2" accent>
            {t("study.stateLearning")}
          </Text>
        ) : (
          <Text size="2" muted="quietest">
            {t("study.stateNone")}
          </Text>
        )}
      </Table.Cell>
      <Table.Cell column="times">
        <Text size="2" muted>
          {row.count}
        </Text>
      </Table.Cell>
      <Table.Cell column="time">
        <Text size="2" muted>
          {time}
        </Text>
      </Table.Cell>
      <Table.Cell column="menu">
        {phase === undefined && <RowMenu word={word} onRemove={() => actions.ask(row.key)} />}
      </Table.Cell>
    </Table.Row>
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
      // The review's cards ride the same round: a store that fails to open leaves every state «—», never the list.
      Promise.all([readWordStudy(), readCardKeys().catch(() => [])])
        .then(([study, cards]) => {
          if (cancelled || requestIdRef.current !== requestId) return;
          // A deleted row keeps «Borrando…» until this reread drops it, so its
          // ✕ never flashes back for the frame in between.
          setTarget((current) =>
            current !== null && !study.rows.some((row) => row.key === current.key) ? null : current,
          );
          setState(
            study.rows.length === 0
              ? { kind: "empty" }
              : { kind: "ready", rows: study.rows, learning: new Set(cards), totalWords: study.total },
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
    // A pull from another device and a row's ✕ (`deleteStudyGroup`) change the store the same way.
    const off = onRecordChanged(onChange);
    return () => {
      cancelled = true;
      off();
    };
  }, [attempt]);

  const [segment, setSegment] = useState<Segment>("all");
  const readyRows = state.kind === "ready" ? state.rows : null;
  const learningKeys = state.kind === "ready" ? state.learning : null;
  const counts = useMemo(() => {
    const total: Record<Segment, number> = { all: 0, learning: 0, phrases: 0 };
    if (readyRows === null || learningKeys === null) return total;
    for (const name of Object.keys(SEGMENT_KEEPS) as Segment[]) {
      total[name] = readyRows.filter((row) => SEGMENT_KEEPS[name](row, learningKeys)).length;
    }
    return total;
  }, [readyRows, learningKeys]);
  // The segment narrows the rows once; typing in the filter narrows what is left.
  const inSegment = useMemo(
    () => (readyRows === null || learningKeys === null ? [] : readyRows.filter((row) => SEGMENT_KEEPS[segment](row, learningKeys))),
    [readyRows, learningKeys, segment],
  );
  const visible = useMemo(() => filterStudyRows(inSegment, query), [inSegment, query]);

  const format = useFormatter();
  // The day «today» means is the one the screen opened on.
  const [openedAt] = useState(() => Date.now());
  const timeZone = deviceZone();
  // Each row carries its time, formatted once with the day it sits under.
  const days = useMemo(
    () =>
      groupByDay(newestRows(visible, shownRows), openedAt, timeZone).map((day) => ({
        ...day,
        rows: day.rows.map((row) => ({
          row,
          time: format.dateTime(row.lastAt, { hour: "2-digit", minute: "2-digit", timeZone }),
        })),
      })),
    [visible, shownRows, openedAt, timeZone, format],
  );

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
  const kind = counts.phrases > 0 ? "entries" : "words";

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
        <Flex align="center" gap="4" wrap="wrap">
          <Box width="420px" maxWidth="100%">
            <TextField.Root
              ref={filterField}
              size="3"
              value={query}
              onChange={(event) => change(event.target.value)}
              label={t("study.filterLabel")}
              hideLabel
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
          </Box>
          <Segments
            label={t("study.filterGroup")}
            value={segment}
            onValueChange={(next) => {
              setSegment(next);
              setShownRows(PAGE_ROWS);
            }}
            options={[
              { value: "all", label: t("study.filterAll", { count: counts.all }) },
              { value: "learning", label: t("study.filterLearning", { count: counts.learning }) },
              { value: "phrases", label: t("study.filterPhrases", { count: counts.phrases }) },
            ]}
          />
        </Flex>
        {filtering && visible.length > 0 && (
          <Text size="2" muted>
            {t("study.filterCount", { shown: visible.length, total: state.totalWords, kind })}
          </Text>
        )}
      </Flex>

      {visible.length === 0 ? (
        <Text size="2" muted>
          {filtering ? t("study.filterNone", { query: query.trim(), kind }) : t("study.segmentNone")}
        </Text>
      ) : (
        <Flex direction="column" gap="4">
          {/* A diary: the days newest first, each with its rows under the column names. */}
          <Table.Root label={t("study.tableLabel")}>
            <Table.Head>
              <Table.Heading column="word">{t("study.columnWord")}</Table.Heading>
              <Table.Heading column="translation">{t("study.columnTranslation")}</Table.Heading>
              <Table.Heading column="state">{t("study.columnState")}</Table.Heading>
              <Table.Heading column="times">{t("study.columnTimes")}</Table.Heading>
              <Table.Heading column="time">{t("study.columnTime")}</Table.Heading>
              <Table.Heading column="menu" />
            </Table.Head>
            {days.map((day) => (
              <Fragment key={`${day.when}-${day.at}`}>
                <Table.Day>
                  <MetaLabel>
                    {day.when === "today"
                      ? t("study.dayToday", { count: day.rows.length })
                      : day.when === "yesterday"
                        ? t("study.dayYesterday", { count: day.rows.length })
                        : t("study.dayOther", {
                            count: day.rows.length,
                            date: format.dateTime(day.at, { weekday: "long", day: "numeric", month: "short", timeZone, ...yearWhenDifferent(day.at, openedAt, timeZone) }),
                          })}
                  </MetaLabel>
                </Table.Day>
                {day.rows.map(({ row, time }) => (
                  <StudyRowItem
                    key={row.key}
                    row={row}
                    learning={state.learning.has(row.key)}
                    time={time}
                    phase={target?.key === row.key ? target.phase : undefined}
                    local={target?.key === row.key && target.local}
                    note={target?.key === row.key && target.note}
                    actions={actions}
                  />
                ))}
              </Fragment>
            ))}
          </Table.Root>
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
