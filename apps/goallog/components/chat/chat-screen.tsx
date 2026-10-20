"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

import { makeChatChange } from "@/app/actions/chat";
import { ChangeRow } from "@/components/chat/change-row";
import { Button, Field, Flex, Notice, Page, Row, ScreenHeader, Section, Text } from "@/components/ui";
import {
  NO_TURNS,
  dropUnanswered,
  readTurns,
  requestTurns,
  subscribeTurns,
  updateTurns,
  type StoredChange,
  type StoredTurn,
} from "@/lib/chat/conversation";
import { chatTurnSchema } from "@/lib/chat/types";

type Shut = "noKey" | "cap" | "capApp";

// What `POST /chat/enviar` answers for a change: its words, or the reason it names nothing of the person's.
type Proposed = { id: string; tool: string; input: Record<string, unknown>; words?: StoredChange["words"]; refused?: string };

const lapse = (turns: StoredTurn[]): StoredTurn[] =>
  turns.map((turn) =>
    turn.role === "chat"
      ? { ...turn, changes: turn.changes.map((c) => (c.state === "open" ? { ...c, state: "lapsed" as const } : c)) }
      : turn,
  );

const restate = (turns: StoredTurn[], at: number, id: string, next: Partial<StoredChange>): StoredTurn[] =>
  turns.map((turn, index) =>
    index === at && turn.role === "chat"
      ? { ...turn, changes: turn.changes.map((c) => (c.id === id ? { ...c, ...next } : c)) }
      : turn,
  );

/**
 * `/chat` (RP-91–RP-94, RNP-07, RNP-17): the conversation in the tab, a message
 * sent to `/chat/enviar`, and each change it proposes made only on the person's
 * «Hacer». Nothing is kept on the server; a change from an earlier message
 * lapses the moment a new one is sent.
 */
export function ChatScreen() {
  const t = useTranslations("chat");
  const turns = useSyncExternalStore(subscribeTurns, readTurns, () => NO_TURNS);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [making, setMaking] = useState(false);
  const [shut, setShut] = useState<Shut | null>(null);
  const [tooLong, setTooLong] = useState(false);
  const sending = useRef(false);
  const makingNow = useRef(false);

  // The last turn is the person's and nothing is pending: the model did not answer it.
  const failed = turns.at(-1)?.role === "person" && !busy && shut === null;
  const retry = failed && text.trim() === "";

  // `null` asks again for the last message, which is already a turn.
  async function ask(message: string | null) {
    if (sending.current || shut !== null) return;
    const typed = message === null ? null : message.trim();
    if (typed === "") return;
    if (typed === null && turns.at(-1)?.role !== "person") return;
    if (typed !== null && !chatTurnSchema.safeParse({ role: "person", text: typed }).success) {
      setTooLong(true);
      return;
    }
    sending.current = true;
    setBusy(true);
    if (typed !== null) {
      updateTurns((all) => [...lapse(all), { role: "person", text: typed }]);
      setText("");
    }
    try {
      const response = await fetch("/chat/enviar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turns: requestTurns(readTurns()) }),
      });
      const body = (await response.json().catch(() => null)) as { reply?: string; changes?: Proposed[]; error?: string } | null;
      if (response.ok && typeof body?.reply === "string" && Array.isArray(body.changes)) {
        const changes: StoredChange[] = body.changes.map(({ id, tool, input, words, refused }) =>
          refused ? { id, tool, input, state: "refused", reason: { key: refused } } : { id, tool, input, state: "open", words },
        );
        updateTurns((all) => [...all, { role: "chat", text: body.reply!, changes }]);
      } else if (response.status === 503 || response.status === 429) {
        // The chat is shut: the message was never answered, so it leaves no turn.
        updateTurns(dropUnanswered);
        setShut(response.status === 503 ? "noKey" : body?.error === "chat.errors.capApp" ? "capApp" : "cap");
      } else if (response.status === 422) {
        // The server refused the message: it leaves no turn, or every later message would carry it.
        updateTurns(dropUnanswered);
        if (typed !== null) setText(typed);
        setTooLong(true);
      }
    } catch {
      // The last turn stays the person's: the screen offers «Intentar otra vez».
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  async function make(at: number, id: string) {
    const turn = readTurns()[at];
    const change = turn?.role === "chat" ? turn.changes.find((c) => c.id === id) : undefined;
    if (!change || change.state !== "open") return;
    try {
      const result = await makeChatChange({ tool: change.tool, input: change.input, requestId: change.id });
      updateTurns((all) =>
        restate(all, at, id, result.ok ? { state: "made" } : { state: "refused", reason: { text: result.message } }),
      );
    } catch {
      // The change stays open: nothing was made.
    }
  }

  async function makeAll(at: number, ids: string[]) {
    if (makingNow.current) return;
    makingNow.current = true;
    setMaking(true);
    try {
      for (const id of ids) await make(at, id);
    } finally {
      makingNow.current = false;
      setMaking(false);
    }
  }

  async function makeOne(at: number, id: string) {
    await makeAll(at, [id]);
  }

  const cap = shut === "cap" || shut === "capApp" ? <Notice role="note">{t(`errors.${shut}`)}</Notice> : null;

  return (
    <Page width="column">
      <ScreenHeader title={t("title")} back={{ href: "/", place: t("back") }} />
      <Flex direction="column" gap="6">
        {shut === "noKey" ? <Notice role="note">{t("errors.noKey")}</Notice> : null}

        {turns.length === 0 && shut === null ? (
          <Section label={t("tryWith")}>
            <Row name={t("examples.month")} onClick={() => void ask(t("examples.month"))} disabled={busy} />
            <Row name={t("examples.amount")} onClick={() => void ask(t("examples.amount"))} disabled={busy} />
          </Section>
        ) : null}

        {turns.map((turn, at) => {
          if (turn.role === "person") {
            return (
              <Section key={at} label={t("you")}>
                <Text as="p" breakWords>
                  {turn.text}
                </Text>
              </Section>
            );
          }
          const open = turn.changes.filter((c) => c.state === "open");
          return (
            <Section key={at} label={t("chat")}>
              {turn.text ? (
                <Text as="p" tone="secondary" breakWords>
                  {turn.text}
                </Text>
              ) : null}
              {turn.changes.length > 0 ? (
                <Flex direction="column" gap="3">
                  {turn.changes.map((change) => (
                    <ChangeRow
                      key={change.id}
                      change={change}
                      only={turn.changes.length === 1}
                      shut={making}
                      onMake={() => void makeOne(at, change.id)}
                    />
                  ))}
                  {open.length > 1 ? (
                    <Button
                      block
                      disabled={making}
                      onClick={() =>
                        void makeAll(
                          at,
                          open.map((c) => c.id),
                        )
                      }
                    >
                      {t("doAll")}
                    </Button>
                  ) : null}
                </Flex>
              ) : null}
            </Section>
          );
        })}

        {busy ? (
          <Text as="p" variant="sentence" tone="muted">
            {t("pending")}
          </Text>
        ) : null}

        {failed ? <Notice>{t("errors.failed")}</Notice> : null}
        {cap}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void (retry ? ask(null) : ask(text));
          }}
        >
          <Flex direction="column" gap="5">
            <Field
              label={t("field")}
              hideLabel
              placeholder={t("placeholder")}
              value={text}
              disabled={busy || shut !== null}
              hint={tooLong ? t("errors.tooLong") : undefined}
              invalid={tooLong}
              onChange={(event) => {
                setText(event.target.value);
                setTooLong(false);
              }}
              autoComplete="off"
            />
            <Button
              block
              type="submit"
              disabled={busy || shut !== null || (!retry && text.trim() === "")}
              aria-busy={busy || undefined}
            >
              {retry ? t("retry") : t("send")}
            </Button>
            <Text as="p" variant="sentence" tone="muted">
              {t("privacy")}
            </Text>
          </Flex>
        </form>
      </Flex>
    </Page>
  );
}
