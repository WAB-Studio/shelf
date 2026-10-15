"use client";

import { useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { z } from "zod";

import { elapsed } from "@/lib/format/elapsed";
import { markRetired, readSyncState } from "@/lib/log/record";
import { Button, Flex, Grid, Heading, MetaLabel, Separator, Spinner, Text } from "@/components/ui";

// A client-side reparse of `lib/sync/devices.ts`'s `DeviceRow`, not an import
// of it: that module opens `import "server-only"`, so a type from it would
// have to be erased perfectly to ship in this bundle. Redeclaring it here
// keeps that boundary a build error can never quietly cross.
const deviceRowSchema = z.object({
  deviceId: z.uuid(),
  label: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  lookups: z.number(),
});
const deviceListSchema = z.array(deviceRowSchema);
type DeviceRow = z.infer<typeof deviceRowSchema>;
const devicesGetResponseSchema = z.object({ devices: deviceListSchema });

const DEVICES_ENDPOINT = "/api/devices";

// The codes `lib/sync/device-label.ts` emits (plus the two the catalog names
// ahead of it); any other shape reads as unknown.
const BROWSER_CODES = ["chrome", "safari", "firefox", "edge", "opera", "samsung"] as const;
const PLATFORM_CODES = ["android", "ios", "ipados", "windows", "macos", "linux"] as const;

function parseLabel(label: string): {
  browser: (typeof BROWSER_CODES)[number] | null;
  platform: (typeof PLATFORM_CODES)[number] | null;
} {
  const [browser, platform, ...rest] = label.split(":");
  if (rest.length > 0) return { browser: null, platform: null };
  return {
    browser: BROWSER_CODES.find((code) => code === browser) ?? null,
    platform: PLATFORM_CODES.find((code) => code === platform) ?? null,
  };
}

type PanelState = { kind: "loading" } | { kind: "failed" } | { kind: "empty" } | { kind: "ready"; rows: DeviceRow[]; now: number };

// One device's own row is either doing nothing, asking the reader to say the
// two halves back, mid-retire, or stuck — never the panel's own state, so
// one row's failure never hides the other's list.
type RowStatus = { kind: "idle" } | { kind: "confirming" } | { kind: "retiring" } | { kind: "failed" };

function DeviceRowItem({
  row,
  now,
  isThisDevice,
  isOnlyDevice,
  status,
  onRetireClick,
  onCancel,
  onConfirm,
  onRetry,
}: {
  row: DeviceRow;
  now: number;
  isThisDevice: boolean;
  isOnlyDevice: boolean;
  status: RowStatus;
  onRetireClick: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onRetry: () => void;
}) {
  const t = useTranslations("account.devices");
  const format = useFormatter();
  const seenAt = new Date(row.lastSeenAt).getTime();
  const gone = elapsed(seenAt, now);
  const since = new Date(row.createdAt);
  // The server formats in its own zone (UTC in production); the reader reads their own day.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { browser, platform } = parseLabel(row.label);
  const name =
    browser && platform
      ? t("label", { browser: t(`browser.${browser}`), platform: t(`platform.${platform}`) })
      : browser
        ? t("labelBrowserOnly", { browser: t(`browser.${browser}`) })
        : platform
          ? t("labelPlatformOnly", { platform: t(`platform.${platform}`) })
          : t("labelUnknown");

  return (
    <Flex direction="column" gap="2">
      {/* `1fr auto`: the label's own width is fixed, so the track beside it is
          what has to clamp (docs/voyager/DESIGN.md "What the data forces"). */}
      <Grid columns="1fr auto" gap="3" align="center">
        <Text weight="medium" truncate>
          {name}
        </Text>
        {isThisDevice && <MetaLabel>{t("thisDevice")}</MetaLabel>}
      </Grid>

      <Text size="2" muted>
        {Number.isNaN(seenAt)
          ? t("neverSeen")
          : gone.unit === "moment"
            ? t("lastSeenMoment")
            : t("lastSeen", { date: format.relativeTime(seenAt, { now, unit: gone.unit }) })}
      </Text>
      {!Number.isNaN(since.getTime()) && (
        <Text size="2" muted>
          {t("since", {
            date: t("sinceDate", {
              day: format.dateTime(since, { day: "numeric", timeZone }),
              month: format.dateTime(since, { month: "short", timeZone }),
            }),
          })}
        </Text>
      )}
      <Text size="2" muted>
        {t("lookups", { count: row.lookups })}
      </Text>

      {status.kind === "idle" && (
        <Flex>
          <Button size="2" variant="soft" color="gray" onClick={onRetireClick}>
            {t("retire")}
          </Button>
        </Flex>
      )}

      {status.kind === "confirming" && (
        <Flex direction="column" gap="2" align="start">
          <Text size="2">{t("confirmBody")}</Text>
          {isThisDevice && <Text size="2">{t("confirmBodyOwn")}</Text>}
          {isOnlyDevice && <Text size="2">{t("confirmBodyLastDevice")}</Text>}
          <Flex gap="2">
            <Button size="2" variant="soft" color="gray" onClick={onCancel}>
              {t("cancel")}
            </Button>
            <Button size="2" onClick={onConfirm}>
              {t("confirm")}
            </Button>
          </Flex>
        </Flex>
      )}

      {status.kind === "retiring" && (
        <Flex align="center" gap="2">
          <Spinner />
          <Text size="2" muted>
            {t("retiring")}
          </Text>
        </Flex>
      )}

      {status.kind === "failed" && (
        // No red in this palette (docs/voyager/DESIGN.md "Failure"): a hairline
        // sets the break off, full-weight ink says it, the accent lives in retry.
        <Flex direction="column" gap="3" align="start">
          <Separator size="4" />
          <Text size="2" weight="bold">
            {t("retireFailed")}
          </Text>
          <Button size="2" onClick={onRetry}>
            {t("retry")}
          </Button>
        </Flex>
      )}
    </Flex>
  );
}

/**
 * The devices the reader's account has copied to (RL-25). Fetches
 * `/api/devices` on mount, never before — this panel only draws inside the
 * account screen, which only mounts with a session — and again whenever
 * `refreshSignal` changes, which the caller bumps once `syncNow()` resolves.
 * The refetch runs quietly behind the rows already on screen: it never
 * forces `loading` back on, so a failed copy never leaves the list spinning.
 * `title` is drawn here, not by the caller: `account-panel.tsx` (module 15)
 * mounts this alongside other sections that carry their own headings too.
 */
export function DevicesPanel({
  refreshSignal,
  onOwnDeviceRetired,
}: {
  refreshSignal: number;
  onOwnDeviceRetired: () => void;
}) {
  const t = useTranslations("account.devices");
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  // Bumped by the panel-level retry, since the fetch runs in an effect and a
  // click cannot call it directly.
  const [attempt, setAttempt] = useState(0);
  // `null` means the local `sync` store has not answered yet: no row reads
  // as "this device" until it has, rather than guessing.
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [response, syncState] = await Promise.all([fetch(DEVICES_ENDPOINT), readSyncState()]);
        if (!response.ok) throw new Error(`devices route answered ${response.status}`);
        const { devices: rows } = devicesGetResponseSchema.parse(await response.json());
        if (cancelled) return;
        setLocalDeviceId(syncState.deviceId);
        setState(rows.length === 0 ? { kind: "empty" } : { kind: "ready", rows, now: Date.now() });
      } catch {
        if (!cancelled) setState({ kind: "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, refreshSignal]);

  function updateRowStatus(deviceId: string, status: RowStatus): void {
    setRowStatus((current) => ({ ...current, [deviceId]: status }));
  }

  function removeRow(deviceId: string): void {
    setState((current) => {
      if (current.kind !== "ready") return current;
      const rows = current.rows.filter((row) => row.deviceId !== deviceId);
      return rows.length === 0 ? { kind: "empty" } : { kind: "ready", rows, now: current.now };
    });
    setRowStatus((current) => {
      const next = { ...current };
      delete next[deviceId];
      return next;
    });
  }

  // Retiring the device in hand marks it retired locally: the copy stays off
  // until a new sign-in mints another identity (RL-24, RL-52).
  async function retire(deviceId: string): Promise<void> {
    updateRowStatus(deviceId, { kind: "retiring" });
    try {
      const response = await fetch(DEVICES_ENDPOINT, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      if (!response.ok) throw new Error(`devices route answered ${response.status}`);
      if (deviceId === localDeviceId) {
        await markRetired();
        onOwnDeviceRetired();
      }
      removeRow(deviceId);
    } catch {
      updateRowStatus(deviceId, { kind: "failed" });
    }
  }

  if (state.kind === "loading") {
    return (
      <Flex direction="column" gap="4">
        <Heading size="5">{t("title")}</Heading>
        <Flex align="center" gap="2">
          <Spinner />
          <Text size="2" muted>
            {t("loading")}
          </Text>
        </Flex>
      </Flex>
    );
  }

  if (state.kind === "failed") {
    return (
      <Flex direction="column" gap="4">
        <Heading size="5">{t("title")}</Heading>
        <Flex direction="column" gap="3" align="start">
          <Separator size="4" />
          <Text size="2" weight="bold">
            {t("loadFailed")}
          </Text>
          <Button
            size="2"
            onClick={() => {
              setState({ kind: "loading" });
              setAttempt((current) => current + 1);
            }}
          >
            {t("retry")}
          </Button>
        </Flex>
      </Flex>
    );
  }

  if (state.kind === "empty") {
    return (
      <Flex direction="column" gap="4">
        <Heading size="5">{t("title")}</Heading>
        <Text size="2" muted>
          {t("empty")}
        </Text>
      </Flex>
    );
  }

  return (
    <Flex direction="column" gap="4">
      <Heading size="5">{t("title")}</Heading>
      <Flex direction="column" gap="4">
        {state.rows.map((row, index) => (
          <Flex direction="column" gap="4" key={row.deviceId}>
            {index > 0 && <Separator size="4" />}
            <DeviceRowItem
              row={row}
              now={state.now}
              isThisDevice={row.deviceId === localDeviceId}
              isOnlyDevice={state.rows.length === 1}
              status={rowStatus[row.deviceId] ?? { kind: "idle" }}
              onRetireClick={() => updateRowStatus(row.deviceId, { kind: "confirming" })}
              onCancel={() => updateRowStatus(row.deviceId, { kind: "idle" })}
              onConfirm={() => void retire(row.deviceId)}
              onRetry={() => void retire(row.deviceId)}
            />
          </Flex>
        ))}
      </Flex>
    </Flex>
  );
}
