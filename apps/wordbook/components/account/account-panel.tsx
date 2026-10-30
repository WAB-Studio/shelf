"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";

import { sendSignInLink, signOut, verifySignInCode } from "@/app/actions/account";
import type { SendSignInLinkResult, VerifySignInCodeResult } from "@/app/actions/account";
import { signInCodeSchema } from "@/lib/account/sign-in-code";
import { clearPending, readPending, savePending } from "@/lib/account/pending-sign-in";
import { countPendingUpload, readSyncState, signOutSync, startCopyFor, writeSyncState } from "@/lib/log/record";
import { clearNavQuery } from "@/lib/nav/query-storage";
import { elapsed, type Elapsed } from "@/lib/format/elapsed";
import { isOtherReader } from "@/lib/log/sync-state";
import { nextQuotaReset } from "@/lib/sync/quota-day";
import { syncNow } from "@/lib/sync/driver";
import type { SyncFailure } from "@/lib/sync/failure";
import type { SyncState } from "@/lib/log/types";
import { Button, Flex, MetaLabel, Separator, Text, TextField } from "@/components/ui";
import { askToKeepStorage, storageKept } from "@/lib/storage/persist";
import { DevicesPanel } from "./devices-panel";

// `lastCopy` and `failedOffline` open on "hace", so the span they take carries
// no direction word of its own; `format.relativeTime` always adds one.
function bareSpan(
  gone: Elapsed,
  format: ReturnType<typeof useFormatter>,
  moment: string,
): string {
  if (gone.unit === "moment") return moment;
  return format.number(gone.value, { style: "unit", unit: gone.unit, unitDisplay: "long" });
}

type EmailFormState =
  | { kind: "idle" }
  | { kind: "sending" }
  // `maybe`: Auth timed out, so the mail may or may not have left (RL-67).
  | { kind: "sent"; maybe?: true }
  | {
      kind: "failed";
      error: Extract<SendSignInLinkResult, { ok: false }>["error"] | "offline";
    };

type SendError = Extract<SendSignInLinkResult, { ok: false }>["error"] | "offline";

type CodeError = Extract<VerifySignInCodeResult, { ok: false }>["error"] | "short" | "offline";

// Driven against a production build, `context.setOffline(true)` rejects the
// browser's own POST to this Server Action outright (`TypeError: Failed to
// fetch`) — the button stuck on "Enviando…" was an *uncaught* rejection, not
// a hang. This clock is the second line of defence, for a connection so slow
// it neither succeeds nor fails within a reader's patience.
const SEND_LINK_TIMEOUT_MS = 8_000;
// How long after a send the reader may ask for another code.
const RESEND_WAIT_MS = 60_000;

// The glyph `docs/wordbook/DESIGN.md` "Settled" names for `CuentaSinRed`: two
// signal arcs and a dot, struck through — the one screen allowed to say the
// connection is the problem.
function OfflineGlyph() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8.5 16.5a5 5 0 017 0" />
      <path d="M5 12.5a10 10 0 0114 0" />
      <circle cx="12" cy="20" r="0.75" fill="currentColor" stroke="none" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

// Drawn only while the browser has not kept the log and the API exists; the
// ask goes out on the reader's tap alone.
function KeepLog() {
  const t = useTranslations("account");
  const [state, setState] = useState<"hidden" | "offer" | "asking">("hidden");
  // Set once a tap was refused; it stays through the next ask until a grant hides the block.
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const kept = await storageKept();
      if (!cancelled && kept === false) setState("offer");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleAsk(): Promise<void> {
    setState("asking");
    const kept = await askToKeepStorage();
    if (kept !== true) setRefused(true);
    setState(kept === true ? "hidden" : "offer");
  }

  if (state === "hidden") return null;
  return (
    <Flex direction="column" gap="2" align="start">
      <Text size="2" muted>
        {t("copy.keepLine")}
      </Text>
      <Button
        type="button"
        size="2"
        variant="outline"
        heavy
        onClick={() => void handleAsk()}
        disabled={state === "asking"}
        aria-busy={state === "asking"}
      >
        {state === "asking" ? t("copy.keepAsking") : t("copy.keepAction")}
      </Button>
      {refused ? (
        <Text size="2" role="status">
          {t("copy.keepRefused")}
        </Text>
      ) : null}
    </Flex>
  );
}

// State 1 (RNL-09): no reader yet, so nothing here ever reaches the network
// beyond the sign-in request the reader themself asks for.
function SignedOutForm() {
  const t = useTranslations("account");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<EmailFormState>({ kind: "idle" });
  const [held, setHeld] = useState<{ at: number | null; now: number } | null>(null);
  const format = useFormatter();
  const router = useRouter();
  const [code, setCode] = useState("");
  const [codeState, setCodeState] = useState<{ kind: "idle" } | { kind: "checking" } | { kind: "failed"; error: CodeError }>({ kind: "idle" });
  // `at` is the last send the countdown counts from; `now` is the clock it reads, so a render never calls `Date.now()`.
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [resend, setResend] = useState<
    { kind: "idle" } | { kind: "sending" } | { kind: "done" } | { kind: "failed"; error: SendError }
  >({ kind: "idle" });
  const codeField = useRef<HTMLInputElement>(null);
  const [focusCode, setFocusCode] = useState(0);

  // A reload or relaunch inside the code's hour reopens the code step (RL-73).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Read after a tick, as the effect below does: the server render never knew the address.
      await Promise.resolve();
      const pending = readPending();
      if (cancelled || !pending) return;
      setEmail(pending.email);
      setSentAt(pending.at);
      setNow(Date.now());
      setState({ kind: "sent" });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const busy = codeState.kind === "checking" || resend.kind === "sending";
  // Before the first read of the clock, or without a record, the wait is not counted.
  const waitSeconds = sentAt === null || now === 0 ? 0 : Math.max(0, Math.ceil((sentAt + RESEND_WAIT_MS - now) / 1_000));
  const counting = state.kind === "sent" && sentAt !== null;
  useEffect(() => {
    if (!counting) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [counting]);

  // The field is disabled while a resend runs, so focus waits for it to be enabled again.
  useEffect(() => {
    if (focusCode > 0) codeField.current?.focus();
  }, [focusCode]);

  async function handleResend(): Promise<void> {
    setResend({ kind: "sending" });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<{ ok: false; error: "offline" }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: "offline" }), SEND_LINK_TIMEOUT_MS);
    });
    let result: SendSignInLinkResult | { ok: false; error: "offline" };
    try {
      result = await Promise.race([sendSignInLink(email), timedOut]);
    } catch {
      result = { ok: false, error: "offline" };
    }
    if (timer) clearTimeout(timer);
    if (!result.ok) {
      setResend({ kind: "failed", error: result.error });
      return;
    }
    const at = Date.now();
    savePending(email, at);
    setSentAt(at);
    setNow(at);
    setCode("");
    setCodeState({ kind: "idle" });
    setState({ kind: "sent", maybe: result.maybe });
    // A resend that may not have left says so on the line above, never «Te mandamos otro código».
    setResend(result.maybe ? { kind: "idle" } : { kind: "done" });
    setFocusCode((current) => current + 1);
  }

  async function handleVerify(): Promise<void> {
    if (!signInCodeSchema.safeParse(code).success) {
      setCodeState({ kind: "failed", error: "short" });
      return;
    }
    setCodeState({ kind: "checking" });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<{ ok: false; error: CodeError }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: "offline" }), SEND_LINK_TIMEOUT_MS);
    });
    let result: { ok: true } | { ok: false; error: CodeError };
    try {
      result = await Promise.race([verifySignInCode(email, code.trim()), timedOut]);
    } catch {
      result = { ok: false, error: "offline" };
    }
    if (timer) clearTimeout(timer);
    if (result.ok) {
      clearPending();
      setCodeState({ kind: "idle" });
      router.refresh();
      return;
    }
    setCodeState({ kind: "failed", error: result.error });
  }

  function chooseOtherEmail(): void {
    clearPending();
    setCode("");
    setCodeState({ kind: "idle" });
    setResend({ kind: "idle" });
    setSentAt(null);
    setState({ kind: "idle" });
  }

  // Half of RNL-09 this component has to hold by hand: `signOut` redirects
  // to `/registro`, so this never mounts on the way out of a session. It
  // only ever catches the other path onto this state — a device that was
  // signed in once, is not any more, and lands here directly (RL-52).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const current = await readSyncState();
      // Offline, the sign-in screen is the precached shell's, not the reader's state.
      if (!navigator.onLine && current.enabled && current.readerId !== null && !current.retired) {
        if (!cancelled) setHeld({ at: current.lastSyncedAt, now: Date.now() });
        return;
      }
      if (!cancelled && current.enabled) await writeSyncState({ enabled: false });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const isHeld = held !== null;
  useEffect(() => {
    if (!isHeld) return;
    // Two events in one tick must not queue two navigations.
    let reloaded = false;
    const onOnline = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [isHeld]);

  async function handleSend(): Promise<void> {
    setState({ kind: "sending" });

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<{ ok: false; error: "offline" }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: "offline" }), SEND_LINK_TIMEOUT_MS);
    });

    let result: SendSignInLinkResult | { ok: false; error: "offline" };
    try {
      result = await Promise.race([sendSignInLink(email), timedOut]);
    } catch {
      // The rejection this call was missing: a cut connection fails the
      // fetch outright, and the reader's own "Enviando…" was never going to
      // move again without one.
      result = { ok: false, error: "offline" };
    }
    if (timer) clearTimeout(timer);
    if (result.ok) {
      const at = Date.now();
      savePending(email, at);
      setSentAt(at);
      setNow(at);
    }
    setResend({ kind: "idle" });
    setState(result.ok ? { kind: "sent", maybe: result.maybe } : { kind: "failed", error: result.error });
  }

  if (held) {
    const gone = held.at === null ? null : elapsed(held.at, held.now);
    return (
      <Flex direction="column" gap="1">
        <MetaLabel>{t("copy.label")}</MetaLabel>
        <Text size="2">
          {gone === null
            ? t("copy.offlineNoCopy")
            : t("copy.failedOffline", { time: bareSpan(gone, format, t("copy.momentSpan")) })}
        </Text>
      </Flex>
    );
  }

  return (
    <Flex direction="column" gap="4">
      {/* The signed-out state of the "Copia" section (`docs/wordbook/DESIGN.md`
          "Settled", `CuentaCopiaEstados`): a state, not a control — the
          control it leads into is the email form right below it. */}
      <Flex direction="column" gap="1">
        <MetaLabel>{t("copy.label")}</MetaLabel>
        <Text size="2">{t("copy.noSessionTitle")}</Text>
        <Text size="2" muted>
          {t("copy.noSessionBody")}
        </Text>
        <KeepLog />
      </Flex>

      {state.kind === "sent" ? (
        <Flex direction="column" gap="3" maxWidth="400px">
          <Text size="2" role="status">
            {state.maybe ? t("maybeSent", { email }) : t("sent", { email })}
          </Text>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleVerify();
            }}
          >
            <Flex direction="column" gap="3">
              <TextField.Root
                ref={codeField}
                size="3"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder={t("codeLabel")}
                aria-label={t("codeLabel")}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                disabled={busy}
              />
              {codeState.kind === "failed" && (
                <Flex direction="column" gap="3" align="start">
                  <Separator size="4" />
                  <Flex gap="2" align="center">
                    {codeState.error === "offline" && <OfflineGlyph />}
                    <Text size="2" weight="bold" role="alert">
                      {t(`codeErrors.${codeState.error}`)}
                    </Text>
                  </Flex>
                </Flex>
              )}
              <Button
                type="submit"
                size="2"
                block={codeState.kind === "failed" && codeState.error === "offline"}
                disabled={busy}
              >
                {codeState.kind === "checking"
                  ? t("checking")
                  : codeState.kind === "failed" && codeState.error === "offline"
                    ? t("retry")
                    : t("enter")}
              </Button>
            </Flex>
          </form>
          <Text size="2" color="gray">
            {t("sentLinkHint")}
          </Text>
          <Button
            type="button"
            size="2"
            variant="soft"
            onClick={() => void handleResend()}
            disabled={busy || waitSeconds > 0}
          >
            {resend.kind === "sending" ? t("resending") : waitSeconds > 0 ? t("resendIn", { seconds: waitSeconds }) : t("resend")}
          </Button>
          {resend.kind === "done" && (
            <Text size="2" role="status">
              {t("resent", { email })}
            </Text>
          )}
          {resend.kind === "failed" && (
            <Flex direction="column" gap="3" align="start">
              <Separator size="4" />
              <Flex gap="2" align="center">
                {resend.error === "offline" && <OfflineGlyph />}
                <Text size="2" weight="bold" role="alert">
                  {t(`errors.${resend.error}`)}
                </Text>
              </Flex>
            </Flex>
          )}
          <Button type="button" size="2" variant="soft" color="gray" onClick={chooseOtherEmail} disabled={busy}>
            {t("otherEmail")}
          </Button>
        </Flex>
      ) : (
        <Flex direction="column" gap="3" maxWidth="400px">
          <TextField.Root
            type="email"
            size="3"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t("emailLabel")}
            aria-label={t("emailLabel")}
            aria-describedby={state.kind === "failed" ? SEND_FAILURE_ID : undefined}
            aria-invalid={state.kind === "failed" ? true : undefined}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />

          {state.kind === "failed" && (
            // No red in this palette (docs/wordbook/DESIGN.md "Failure"): a
            // hairline sets the break off, full-weight ink says it. Offline
            // alone carries the glyph `CuentaSinRed` draws — the one screen
            // this app lets name the connection.
            <Flex direction="column" gap="3" align="start">
              <Separator size="4" />
              <Flex gap="2" align="center">
                {state.error === "offline" && <OfflineGlyph />}
                <Text id={SEND_FAILURE_ID} size="2" weight="bold" role="alert">
                  {t(`errors.${state.error}`)}
                </Text>
              </Flex>
            </Flex>
          )}

          <Button
            size="2"
            block={state.kind === "failed" && state.error === "offline"}
            onClick={() => void handleSend()}
            disabled={state.kind === "sending"}
          >
            {state.kind === "sending"
              ? t("sending")
              : state.kind === "failed" && state.error === "offline"
                ? t("retry")
                : t("copy.noSessionAction")}
          </Button>
        </Flex>
      )}
    </Flex>
  );
}

// The id the email field points at while a send is refused.
const SEND_FAILURE_ID = "send-link-failure";

type SyncStatus = { kind: "idle" } | { kind: "syncing" } | { kind: "failed"; cause: SyncFailure };

// The signed-in screen. The copy has four faces: waiting for the reader's tap
// (nothing leaves the device until then, RL-52), copying, retired (the server
// or the reader ended this device's copy), and the running copy of today.
// `DevicesPanel` is the module 21 line the contract names. No "Dejar de
// copiar" here (`docs/wordbook/DESIGN.md` "Settled"): the doors out are
// `signOut` below and retiring this device from `DevicesPanel`.
function SyncedSection({
  email,
  readerId,
  syncState,
  syncStatus,
  syncCount,
  syncVersion,
  now,
  confirmedHere,
  onConfirm,
  onSyncNow,
  onOwnDeviceRetired,
}: {
  email: string;
  readerId: string;
  syncState: SyncState;
  syncStatus: SyncStatus;
  syncCount: number;
  syncVersion: number;
  now: number;
  confirmedHere: boolean;
  onConfirm: () => void;
  onSyncNow: () => void;
  onOwnDeviceRetired: () => void;
}) {
  const t = useTranslations("account");
  const format = useFormatter();
  const confirmed = syncState.enabled && syncState.readerId === readerId;

  // Fires before the sign-out `<form>` submits: `signOut` redirects to
  // `/registro`, so this component never gets to unmount and run an effect
  // of its own first (RNL-09). The same gesture drops the box's last query,
  // which otherwise pre-fills `Buscar` for whoever signs in next on this tab.
  function handleSignOutClick(): void {
    void signOutSync();
    clearNavQuery();
  }

  function renderCopyState() {
    if (syncState.retired) {
      return (
        <Flex direction="column" gap="1">
          <Text variant="translation">{t("copy.retiredTitle")}</Text>
          <Text size="2" muted>
            {t("copy.retiredBody")}
          </Text>
        </Flex>
      );
    }

    if (!confirmed && !confirmedHere) {
      return (
        <Flex direction="column" gap="3" align="start">
          <Flex direction="column" gap="1">
            <Text variant="translation">{t("copy.confirmTitle", { email })}</Text>
            <Text size="2" muted>
              {t("copy.confirmBody")}
            </Text>
            {isOtherReader(syncState, readerId) && (
              <Text size="2" muted>
                {t("copy.otherReader")}
              </Text>
            )}
          </Flex>
          <Button size="2" onClick={onConfirm}>
            {t("copy.confirmAction")}
          </Button>
        </Flex>
      );
    }

    if (syncStatus.kind === "syncing") {
      return confirmedHere ? (
        <Flex direction="column" gap="1">
          <Text variant="translation">{t("copy.confirmTitle", { email })}</Text>
          <Text size="2" muted>
            {t("copy.syncingSearches", { count: syncCount })}
          </Text>
        </Flex>
      ) : (
        <Text size="2">{t("copy.syncingSearches", { count: syncCount })}</Text>
      );
    }

    if (syncStatus.kind === "failed") {
      const { cause } = syncStatus;
      const offlineBody = syncState.lastSyncedAt
        ? t("copy.failedOffline", {
            time: bareSpan(elapsed(syncState.lastSyncedAt, now), format, t("copy.momentSpan")),
          })
        : t("copy.failedBodyFirst");
      return (
        // No red in this palette (docs/wordbook/DESIGN.md "Failure"): a
        // hairline sets the break off, full-weight ink says it, and the
        // retry rides the ordinary accent button. A quota refusal has no
        // retry: another attempt gets the same answer until the UTC day turns.
        <Flex direction="column" gap="3" align="start">
          <Separator size="4" />
          <Text size="2" weight="bold">
            {cause === "quota"
              ? t("copy.failedQuotaTitle")
              : cause === "offline"
                ? t("copy.failedOfflineTitle")
                : t("copy.failedTitle")}
          </Text>
          <Text size="2" muted>
            {cause === "quota"
              ? t("copy.failedQuotaBody", {
                  time: format
                    .dateTime(nextQuotaReset(now), {
                      hour: "numeric",
                      minute: "2-digit",
                      hour12: true,
                      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    })
                    .replace(/\s/g, "\u00a0"),
                })
              : cause === "offline"
                ? offlineBody
                : t("copy.failedServer")}
          </Text>
          {cause !== "quota" && (
            <Button size="2" onClick={onSyncNow}>
              {t("copy.failedAction")}
            </Button>
          )}
        </Flex>
      );
    }

    if (!syncState.lastSyncedAt) {
      return <Text size="2">{t("copy.neverSynced")}</Text>;
    }

    const gone = elapsed(syncState.lastSyncedAt, now);
    return (
      <Text size="2">
        {gone.unit === "moment"
          ? t("copy.lastCopyMoment")
          : t("copy.lastCopy", { time: bareSpan(gone, format, "") })}
      </Text>
    );
  }

  // The confirm title already carries the address; saying it twice is noise.
  const titleShown =
    !syncState.retired && ((!confirmed && !confirmedHere) || (confirmedHere && syncStatus.kind === "syncing"));

  return (
    <Flex direction="column" gap="4">
      {!titleShown && <Text size="2">{t("signedInAs", { email })}</Text>}

      <Flex direction="column" gap="1">
        <MetaLabel>{t("copy.label")}</MetaLabel>
        {renderCopyState()}
        <KeepLog />
      </Flex>

      <Separator size="4" />

      <DevicesPanel refreshSignal={syncVersion} onOwnDeviceRetired={onOwnDeviceRetired} />

      <Separator size="4" />

      {/* A raw server action, not `execute()`: `signOut` throws Next's own
          redirect, and a `<form>` is the invocation the framework documents
          for that (node_modules/next/dist/docs's server-actions guide). */}
      <form action={signOut}>
        <Button size="2" type="submit" variant="soft" color="gray" onClick={handleSignOutClick}>
          {t("signOut")}
        </Button>
      </form>
    </Flex>
  );
}

// The device's own `sync` row (IndexedDB, never the network) has to be read
// before anything draws. Mounting never turns the copy on: only the reader's
// tap does (RL-52).
function SignedInPanel({ reader }: { reader: { id: string; email: string } }) {
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ kind: "idle" });
  // True once the reader tapped the button in this mount: the confirm title
  // stays above the copying and failed states the board draws under it.
  const [confirmedHere, setConfirmedHere] = useState(false);
  // The `{count}` `copy.syncingSearches` reads while a round is in flight: the
  // local log's own size at the moment the round starts.
  const [syncCount, setSyncCount] = useState(0);
  // Bumped once `syncNow()` resolves without failing: the device
  // list's own refetch keys off this, never off a timer (module 35).
  const [syncVersion, setSyncVersion] = useState(0);
  // The clock the last-copy line reads; a render never calls `Date.now()` itself.
  const [now, setNow] = useState(0);

  // `silent` is the pull on open: the last-copy line stays as it is while it
  // runs (`CuentaCopiaAlAbrir`), and only a failure draws anything.
  async function runSync(silent = false): Promise<void> {
    if (!silent) {
      setSyncStatus({ kind: "syncing" });
      setSyncCount(await countPendingUpload());
    }
    const outcome = await syncNow();
    setSyncState(await readSyncState());
    setNow(Date.now());
    setSyncStatus(outcome.kind === "failed" ? { kind: "failed", cause: outcome.cause } : { kind: "idle" });
    // A failed round changed nothing the list shows, and refetching on a dead line draws its own failure.
    if (outcome.kind !== "failed") setSyncVersion((current) => current + 1);
  }

  async function confirm(): Promise<void> {
    setConfirmedHere(true);
    setSyncStatus({ kind: "syncing" });
    setSyncState(await startCopyFor(reader.id));
    setNow(Date.now());
    await runSync();
  }

  // A signed-in reader has no code step to reopen (RL-73).
  useEffect(() => {
    clearPending();
  }, []);

  // Local only: the line's age moves with the clock, never with a request.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const current = await readSyncState();
      if (cancelled) return;
      setSyncState(current);
      setNow(Date.now());
      // The pull on open: only a copy this reader confirmed and that is not retired.
      if (current.enabled && current.readerId === reader.id && !current.retired) await runSync(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [reader.id]);

  // The IndexedDB read settles in a beat; nothing is drawn while it does,
  // same as the near-instant reads `record.ts` backs elsewhere.
  if (!syncState) return null;

  return (
    <SyncedSection
      email={reader.email}
      readerId={reader.id}
      syncState={syncState}
      syncStatus={syncStatus}
      syncCount={syncCount}
      syncVersion={syncVersion}
      now={now}
      confirmedHere={confirmedHere}
      onConfirm={() => void confirm()}
      onSyncNow={() => void runSync()}
      onOwnDeviceRetired={() => void readSyncState().then(setSyncState)}
    />
  );
}

/**
 * The account screen's two states (RL-22, RL-52): no reader, or a reader who
 * confirms the copy before anything leaves the device. `reader` comes from
 * the server component above, the only place `getReader()` runs.
 */
export function AccountPanel({ reader }: { reader: { id: string; email: string } | null }) {
  if (!reader) return <SignedOutForm />;
  return <SignedInPanel reader={reader} />;
}
