"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";

import { readSourceV1 as readSource, saveDraftV1 as saveDraft } from "@/lib/import/draft-store";
import type { ImportDraftV1 } from "@/lib/import/draft";
import { parseTemplateV1 as parseTemplate } from "@/lib/import/template";
import { Button, CodeBlock, FilePick, Flex, Notice, Page, ScreenHeader, Section, Text, TextArea } from "@/components/ui";
import { messageKey, type MessageKey } from "@/i18n/translator";

const MAX_BYTES = 4 * 1024 * 1024;

// The keys `/importar/leer` answers; anything else reads as the model failing,
// so a key a build does not know never reaches `t`.
const KNOWN_ERRORS = new Set([
  "import.errors.signedOut",
  "import.errors.tooBig",
  "import.errors.unreadableType",
  "import.errors.noKey",
  "import.errors.cap",
  "import.errors.blank",
  "import.errors.empty",
  "import.errors.modelFailed",
  "import.errors.modelInvalid",
]);

type Failure =
  | { kind: "templateLine"; cut: boolean; lines: { line: number; expected: string; unit?: string; text: string }[] }
  | { kind: "key"; key: MessageKey; values?: Record<string, string> };

const subscribeNothing = () => () => {};

// The box's own layout, replayed in a hidden twin: where `[start, end)` really sits, wrapped lines included.
function spanOffset(area: HTMLTextAreaElement, start: number, end: number) {
  const style = getComputedStyle(area);
  const twin = document.createElement("div");
  for (const name of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "tabSize"] as const) {
    twin.style[name] = style[name];
  }
  twin.style.position = "absolute";
  twin.style.visibility = "hidden";
  twin.style.boxSizing = "border-box";
  twin.style.width = `${area.clientWidth}px`;
  twin.style.whiteSpace = "pre-wrap";
  twin.style.overflowWrap = "break-word";
  twin.textContent = area.value.slice(0, start);
  const span = document.createElement("span");
  span.textContent = area.value.slice(start, end) || ".";
  twin.appendChild(span);
  document.body.appendChild(twin);
  const offset = { top: span.offsetTop, height: span.offsetHeight };
  twin.remove();
  return offset;
}

// Room kept clear above the box and for the fixed bottom nav below the line.
const SCREEN_TOP = 16;
const SCREEN_BOTTOM = 96;

// Scrolls the page so the box starts on screen and the selected line ends above the nav.
function revealSelection(area: HTMLTextAreaElement) {
  const { top, height } = spanOffset(area, area.selectionStart, area.selectionEnd);
  const rect = area.getBoundingClientRect();
  const lineBottom = rect.top + area.clientTop + top + height - area.scrollTop;
  const screen = window.visualViewport?.height ?? window.innerHeight;
  let by = rect.top - SCREEN_TOP;
  if (lineBottom - by > screen - SCREEN_BOTTOM) by = lineBottom - (screen - SCREEN_BOTTOM);
  if (Math.abs(by) < 1) return;
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollBy({ top: by, behavior: calm ? "auto" : "smooth" });
}

// Selects line `n` (1-based) of the box without its newline and scrolls it into view.
function selectLine(area: HTMLTextAreaElement, n: number) {
  const lines = area.value.split("\n");
  const start = lines.slice(0, n - 1).reduce((sum, l) => sum + l.length + 1, 0);
  const end = start + (lines[n - 1]?.length ?? 0);
  const { top, height } = spanOffset(area, start, end);
  if (top < area.scrollTop) area.scrollTop = top;
  else if (top + height > area.scrollTop + area.clientHeight) area.scrollTop = top + height - area.clientHeight;
  area.focus({ preventScroll: true });
  area.setSelectionRange(start, end);
  revealSelection(area);
}

// What each failure draws: where its box sits and what it offers next.
function placement(failure: Failure) {
  if (failure.kind === "templateLine") return { place: "below", template: true } as const;
  switch (failure.key) {
    case "import.errors.noKey":
    case "import.errors.cap":
      return { place: "top", template: true } as const;
    case "import.errors.blank":
    case "import.errors.empty":
    case "import.errors.modelFailed":
    case "import.errors.modelInvalid":
      return { place: "below", template: true } as const;
    default:
      return { place: "upload", template: false } as const;
  }
}

/**
 * `/metas/importar` (RP-37, RNP-13): a pasted text or one file goes to
 * `/importar/leer`, and its draft is carried to the review. Every failure keeps
 * the text. The privacy line sits above «Leer el plan» in every state.
 */
export function ImportScreen() {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  // Storage is the client's: the server snapshot is the empty box, and the
  // stored text shows once hydrated. What the person types wins from then on.
  const stored = useSyncExternalStore(subscribeNothing, () => readSource() ?? "", () => "");
  const [typed, setTyped] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const alertBox = useRef<HTMLDivElement>(null);
  // The error row last pressed, so the list shows which line the box is pointing at.
  const [pressed, setPressed] = useState<number | null>(null);
  // The server's box is live before the scripts land: what it holds at hydration was typed.
  useLayoutEffect(() => {
    const early = box.current?.value ?? "";
    if (early !== "") setTyped(early);
  }, []);
  // A keyboard rising shrinks the screen; the selected line follows it.
  useEffect(() => {
    const follow = () => {
      if (box.current && document.activeElement === box.current) revealSelection(box.current);
    };
    const screen = window.visualViewport;
    window.addEventListener("resize", follow);
    screen?.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("resize", follow);
      screen?.removeEventListener("resize", follow);
    };
  }, []);
  const text = typed ?? stored;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [showTemplate, setShowTemplate] = useState(true);
  const [copied, setCopied] = useState(false);

  // The file whose text the box holds, named under it while its list stands.
  const [fileNote, setFileNote] = useState<string | null>(null);
  const reread = failure?.kind === "templateLine" ? parseTemplate(text) : null;
  // The list goes when the text stops being the template; the notice says why.
  const notTemplate = reread !== null && !reread.matched && text.trim() !== "";
  const shown: Failure | null = (() => {
    if (failure?.kind !== "templateLine") return failure;
    const r = reread!;
    if (!r.matched || !("error" in r)) return null;
    const written = text.split("\n");
    return { kind: "templateLine", cut: r.cut, lines: r.errors.map((e) => ({ ...e, text: written[e.line - 1] ?? "" })) };
  })();
  const listed = shown?.kind === "templateLine";
  // A reading with errors hands focus to the list; the key is the failure, which is new on every reading.
  useEffect(() => {
    if (failure?.kind === "templateLine") alertBox.current?.focus();
  }, [failure]);

  const placed = shown ? placement(shown) : null;
  // The key and the cap shut the model; the template still reads.
  const modelShut =
    failure?.kind === "key" && (failure.key === "import.errors.noKey" || failure.key === "import.errors.cap");
  const retry = failure?.kind === "key" && failure.key.startsWith("import.errors.model");

  function fail(next: Failure) {
    setFailure(next);
    setPressed(null);
    setShowTemplate(false);
  }

  // `source` is the text a template line is quoted from; `saved` is what the box holds again next time.
  async function send(form: FormData, source: string, saved: string | null, fileName: string | null = null) {
    setBusy(true);
    setFailure(null);
    setFileNote(null);
    try {
      const response = await fetch("/importar/leer", { method: "POST", body: form });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        cut?: boolean;
        errors?: { line: number; expected: string; unit?: string }[];
        via?: "template" | "model";
        draft?: ImportDraftV1;
      } | null;

      if (response.ok && body?.draft && body.via) {
        saveDraft({ via: body.via, draft: body.draft, source: saved, sourceName: fileName });
        router.push("/metas/importar/revisar");
        return;
      }
      if (body?.error === "import.errors.templateLine" && body.errors?.length) {
        const written = source.split("\n");
        // A text file's own text is the box's, read again as any pasted one.
        if (fileName !== null && source !== "") {
          setTyped(source);
          setFileNote(fileName);
        }
        fail({
          kind: "templateLine",
          cut: body.cut === true,
          lines: body.errors.map((e) => ({ ...e, text: written[e.line - 1] ?? "" })),
        });
      } else if (body?.error && KNOWN_ERRORS.has(body.error)) {
        fail({ kind: "key", key: messageKey(body.error) });
      } else {
        fail({ kind: "key", key: "import.errors.modelFailed" });
      }
    } catch {
      fail({ kind: "key", key: "import.errors.modelFailed" });
    } finally {
      setBusy(false);
    }
  }

  function readText() {
    if (busy) return;
    if (text.trim() === "") {
      fail({ kind: "key", key: "import.errors.blank" });
      return;
    }
    const form = new FormData();
    form.set("text", text);
    void send(form, text, text);
  }

  async function readFile(file: File) {
    if (busy) return;
    if (file.size > MAX_BYTES) {
      fail({
        kind: "key",
        key: "import.errors.tooBigNamed",
        values: {
          file: file.name,
          size: t("import.size", { value: format.number(file.size / (1024 * 1024), { maximumFractionDigits: 1 }) }),
        },
      });
      return;
    }
    const form = new FormData();
    form.set("file", file);
    // Only a text file can fail on a template line; its text is the line's source.
    const binary = file.type === "application/pdf" || file.type.startsWith("image/") || /\.pdf$/i.test(file.name);
    await send(form, binary ? "" : await file.text().catch(() => ""), null, file.name);
  }

  function copyTemplate() {
    void navigator.clipboard
      .writeText(t("import.template.example"))
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }

  const notice = shown ? (
    shown.kind === "templateLine" ? (
      <Notice
        ref={alertBox}
        focusable
        title={t("import.errors.templateCount", { count: shown.lines.length })}
        aside={shown.cut ? t("import.errors.templateCut") : undefined}
        current={pressed}
        onRow={(index) => {
          setPressed(index);
          if (box.current) selectLine(box.current, shown.lines[index].line);
        }}
        rows={shown.lines.map((e) =>
          t("import.errors.templateLine", {
            line: e.line,
            text: e.text,
            expected: t(messageKey(e.expected), { unit: e.unit ?? "" }),
          }),
        )}
      />
    ) : (
      <Notice>{t(shown.key, shown.values)}</Notice>
    )
  ) : null;

  return (
    <Page width="full">
      <ScreenHeader
        title={t("import.title")}
        back={{ href: "/metas", place: t("common.nav.goals") }}
      />
      <Flex direction="column" gap="6" maxWidth="640px">
        <Flex direction="column" gap="5">
          {placed?.place === "top" ? notice : null}

          <TextArea
            ref={box}
            label={t("import.textLabel")}
            placeholder={t("import.placeholder")}
            rows={failure ? 8 : 10}
            value={text}
            disabled={busy}
            invalid={listed}
            onChange={(event) => {
              setTyped(event.target.value);
              setPressed(null);
            }}
          />

          {listed && fileNote ? (
            <Text as="p" variant="sentence" tone="muted">
              {t("import.fileNote", { name: fileNote })}
            </Text>
          ) : null}

          <FilePick
            label={t("import.upload")}
            hint={t("import.uploadHint")}
            disabled={busy || modelShut}
            onPick={(file) => void readFile(file)}
          />

          {placed?.place === "upload" ? notice : null}

          <Text as="p" variant="sentence" tone="muted">
            {t("import.privacy")}
          </Text>

          {placed?.place === "below" ? notice : null}

          {notTemplate ? <Notice role="note">{t("import.notTemplate")}</Notice> : null}

          <Button block onClick={readText} disabled={busy} aria-busy={busy || undefined}>
            {busy ? t("import.reading") : retry ? t("import.retry") : t("import.read")}
          </Button>
          {busy ? (
            <Text as="p" variant="sentence" tone="muted">
              {t("import.slow")}
            </Text>
          ) : null}
        </Flex>

        {placed?.template && !showTemplate ? (
          <Flex>
            <Button variant="ghost" tone="accent" onClick={() => setShowTemplate(true)}>
              {t("import.template.show")}
            </Button>
          </Flex>
        ) : null}

        {showTemplate ? (
          <Section label={t("import.template.label")}>
            <Text as="p" variant="sentence" tone="muted">
              {t("import.template.note")}
            </Text>
            <CodeBlock>{t("import.template.example")}</CodeBlock>
            <Flex>
              <Button variant="ghost" tone="accent" onClick={copyTemplate}>
                {copied ? t("import.template.copied") : t("import.template.copy")}
              </Button>
            </Flex>
          </Section>
        ) : null}
      </Flex>
    </Page>
  );
}
