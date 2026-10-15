"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { createAccessToken, revokeAccessToken } from "@/app/actions/tokens";
import {
  Button,
  CodeBlock,
  Field,
  Figure,
  Fold,
  Flex,
  Notice,
  Page,
  ScreenHeader,
  Section,
  Separator,
  Text,
} from "@/components/ui";
import { messageKey, type MessageKey } from "@/i18n/translator";
import { createTokenSchema } from "@/lib/validation/token";

import { RevokeSheet } from "./revoke-sheet";

export type ConnectionRow = {
  id: string;
  kind: "personal" | "oauth";
  name: string;
  revoked: boolean;
  revokedAt: ConnectionStamp | null;
  expiredAt: ConnectionStamp | null;
  created: ConnectionStamp;
  used: ConnectionStamp | null;
  returnHost: string | null;
  folded: boolean;
};

// An instant as the page reads it in the person's zone.
export type ConnectionStamp = { today: boolean; date: string; time: string };

type Created = { name: string; key: string };

type CopyState = "idle" | "copied" | "failed";

const COPIED_MS = 2000;

function Copyable({ text, label }: { text: string; label: string }) {
  const t = useTranslations("connections");
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <Flex direction="column" gap="2">
      <Flex align="center" gap="3">
        <CodeBlock>{text}</CodeBlock>
        <Button variant="outline" tap={44} aria-label={label} onClick={() => void copy()}>
          {t("connector.copy")}
        </Button>
      </Flex>
      {state === "idle" ? null : (
        <Text as="p" variant="sentence" role="status" aria-live="polite" tone={state === "copied" ? "accent" : "muted"}>
          {state === "copied" ? (
            <Flex as="span" align="center" gap="1">
              <Check size={14} strokeWidth={2} aria-hidden />
              {t("connector.copied")}
            </Flex>
          ) : (
            t("connector.copyFailed")
          )}
        </Text>
      )}
    </Flex>
  );
}

function Keys({ rows, section, foldKey, onAsk, onRenew, busy }: {
  rows: ConnectionRow[];
  section: string;
  foldKey: "folds.keys" | "folds.connections";
  onAsk: (row: ConnectionRow) => void;
  onRenew: (row: ConnectionRow) => void;
  busy: boolean;
}) {
  const t = useTranslations("connections");
  const fig = { fig: (chunks: ReactNode) => <Figure variant="meta" value={chunks} /> };
  const stamp = (when: ConnectionStamp, clock: boolean) =>
    when.today
      ? t.rich("row.stampToday", { time: when.time, ...fig })
      : t.rich(clock ? "row.stampOnClock" : "row.stampOn", { date: when.date, time: when.time, ...fig });
  // `<created>` and `<used>` in a message stand for the stamps, which are nodes, not text.
  const at = (created: ReactNode, used?: ReactNode) => ({ created: () => created, used: () => used, ...fig });
  const line = (row: ConnectionRow) => {
    if (row.revokedAt) return t.rich("row.revokedMeta", { date: row.revokedAt.date, ...fig });
    if (row.expiredAt) {
      if (!row.used) return t.rich("row.expiredUnused", { date: row.expiredAt.date, ...fig });
      return t.rich("row.expiredMeta", { date: row.expiredAt.date, used: row.used.date, ...fig });
    }
    const created = stamp(row.created, false);
    const used = row.used ? stamp(row.used, true) : null;
    if (row.kind === "oauth") {
      return used ? t.rich("oauth.metaUsed", { ...at(created, used) }) : t.rich("oauth.metaUnused", { ...at(created) });
    }
    // A key made today opens its line with a capital (`ConexionesTelefono`); an older one stays lower-case.
    const first = row.created.today;
    if (used) return t.rich(first ? "row.metaUsedFirst" : "row.metaUsed", { ...at(created, used) });
    return t.rich(first ? "row.metaUnusedFirst" : "row.metaUnused", { ...at(created) });
  };

  const revokeName = (row: ConnectionRow) => {
    if (row.kind === "personal") return t("row.revokeKey", { name: row.name });
    if (row.returnHost) return t("row.revokeHost", { name: row.name, host: row.returnHost });
    return t("row.revokeConnection", { name: row.name, date: row.created.date });
  };
  const host = (row: ConnectionRow) =>
    t.rich("oauth.returns", {
      host: row.returnHost ?? "",
      strong: (chunks) => (
        <Text asChild variant="sentence" tone="ink" strong>
          <strong>{chunks}</strong>
        </Text>
      ),
    });
  const render = (row: ConnectionRow) => {
    const dead = row.revoked || row.expiredAt !== null;
    const renewable = row.kind === "personal" && row.expiredAt !== null && !row.revoked;
    return (
      <div key={row.id}>
        <Separator />
        <Flex align="center" justify="between" gap="3" py="3" minHeight="56px">
          <Flex direction="column" align="start" gap="1" minWidth="0">
            <Text variant="name" tone={dead ? "muted" : undefined}>
              {row.name}
            </Text>
            {!dead && row.returnHost ? <Text variant="sentence">{host(row)}</Text> : null}
            <Text variant="sentence">{line(row)}</Text>
            {renewable ? (
              <Button
                variant="ghost"
                tone="accent"
                tap={44}
                aria-label={t("row.renewKey", { name: row.name })}
                onClick={() => onRenew(row)}
              >
                {t("row.renew")}
              </Button>
            ) : null}
          </Flex>
          {dead ? null : (
            <Button variant="outline" tap={44} disabled={busy} aria-label={revokeName(row)} onClick={() => onAsk(row)}>
              {t("row.revoke")}
            </Button>
          )}
        </Flex>
      </div>
    );
  };
  const folded = rows.filter((row) => row.folded);

  return (
    <Section label={section}>
      {rows.filter((row) => !row.folded).map(render)}
      {folded.length > 0 ? <Fold label={t(foldKey, { count: folded.length })}>{folded.map(render)}</Fold> : null}
    </Section>
  );
}

/**
 * `/conexiones` (RP-38): the list of keys and connections, the form that mints
 * one, and the one render that shows its value. The key is state, never props
 * and never storage: leaving or refreshing the page loses it for good (RNP-17).
 */
export function ConnectionsScreen({ rows, siteUrl }: { rows: ConnectionRow[]; siteUrl: string }) {
  const t = useTranslations("connections");
  const root = useTranslations();
  const router = useRouter();
  const [created, setCreated] = useState<Created | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<MessageKey | null>(null);
  const [asked, setAsked] = useState<ConnectionRow | null>(null);
  const [pending, startTransition] = useTransition();
  const nameField = useRef<HTMLInputElement>(null);

  const keys = rows.filter((row) => row.kind === "personal");
  const connected = rows.filter((row) => row.kind === "oauth");
  const place = { href: "/metas", place: useTranslations("common.nav")("goals") };

  function create() {
    const checked = createTokenSchema.safeParse({ name });
    if (!checked.success) {
      setError(messageKey(checked.error.issues[0].message));
      return;
    }
    startTransition(async () => {
      const result = await createAccessToken({ name });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setName("");
      setCreated({ name: name.trim(), key: result.key });
    });
  }

  // A lapsed key's name goes back in the field so the new one replaces it by that name.
  function renew(row: ConnectionRow) {
    setName(row.name);
    setError(null);
    nameField.current?.focus();
  }

  function revoke(id: string) {
    startTransition(async () => {
      // Zero rows reads as «already revoked»: either way the list is refreshed.
      await revokeAccessToken({ tokenId: id });
      setAsked(null);
      router.refresh();
    });
  }

  if (created) {
    const command = t("created.claudeCode", { url: siteUrl, key: created.key });
    return (
      <Page>
        <ScreenHeader title={t("created.title")} back={place} />
        <Notice role="note">{t("created.once")}</Notice>
        <Section label={created.name}>
          <Copyable text={created.key} label={t("created.copyName")} />
        </Section>
        <Section label={t("created.terminal")}>
          <Copyable text={command} label={t("created.copyCommandName")} />
        </Section>
        <Text as="p" variant="sentence" tone="muted">
          {t("created.connected")}
        </Text>
        <Button variant="outline" tap={52} block onClick={() => setCreated(null)}>
          {t("created.done")}
        </Button>
      </Page>
    );
  }

  const form = (
    <Section label={keys.length > 0 || connected.length > 0 ? t("sections.another") : t("sections.first")}>
      <Field
        ref={nameField}
        label={t("nameLabel")}
        placeholder={t("namePlaceholder")}
        hint={error ? root(error) : t("nameHint")}
        invalid={error !== null}
        value={name}
        disabled={pending}
        onChange={(event) => setName(event.target.value)}
      />
      <Button tap={52} block disabled={pending} aria-busy={pending || undefined} onClick={create}>
        {pending ? t("creating") : t("create")}
      </Button>
    </Section>
  );

  return (
    <Page>
      <ScreenHeader chat title={t("title")} back={place} />
      <Text as="p">{t("intro")}</Text>
      {keys.length > 0 ? (
        <Keys
          rows={keys}
          section={t("sections.keys")}
          foldKey="folds.keys"
          onAsk={setAsked}
          onRenew={renew}
          busy={pending}
        />
      ) : null}
      {connected.length > 0 ? (
        <Keys
          rows={connected}
          section={t("sections.oauth")}
          foldKey="folds.connections"
          onAsk={setAsked}
          onRenew={renew}
          busy={pending}
        />
      ) : null}
      {form}
      <RevokeSheet
        open={asked !== null}
        onOpenChange={(open) => {
          if (!open) setAsked(null);
        }}
        name={asked?.name ?? ""}
        kind={asked?.kind ?? "personal"}
        onConfirm={() => asked && revoke(asked.id)}
        busy={pending}
      />
      <Section label={t("sections.connector")}>
        <Text as="p" variant="sentence" tone="muted">
          {t("connector.note")}
        </Text>
        <Copyable text={`${siteUrl}/mcp`} label={t("connector.copyName")} />
      </Section>
    </Page>
  );
}
