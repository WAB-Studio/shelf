"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Flex, IconButton, Text } from "@radix-ui/themes";

import styles from "./copy-field.module.css";

// How long the button holds the copied glyph before falling back to `Copy`.
const COPIED_MS = 2000;

/**
 * A value a person has to carry out of the app: an endpoint URL, a request body,
 * a bearer token shown once. The value is a read-only control rather than plain
 * text so it stays labelable, focusable and selectable — the manual path when the
 * clipboard is unavailable, an insecure context or denied. Nothing here logs or
 * stores `value`; the only state is the copied flag.
 */
export function CopyField({
  id,
  label,
  value,
  copyLabel,
  copiedLabel,
  failedLabel,
  multiline,
  tone = "neutral",
}: {
  id: string;
  label: string;
  value: string;
  copyLabel: string;
  copiedLabel: string;
  failedLabel: string;
  multiline?: boolean;
  tone?: "neutral" | "secret";
}) {
  const valueRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (status === "idle") return;
    const timer = setTimeout(() => setStatus("idle"), COPIED_MS);
    return () => clearTimeout(timer);
  }, [status]);

  async function copy() {
    try {
      // Reading `navigator.clipboard` throws when the API is absent; the whole
      // access sits inside the try so both failures land on the same path.
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      valueRef.current?.focus();
      valueRef.current?.select();
      setStatus("failed");
    }
  }

  const commonProps = {
    id,
    ref: valueRef,
    className: styles.value,
    value,
    readOnly: true,
    spellCheck: false,
    autoComplete: "off",
    "data-tone": tone,
  } as const;

  return (
    <Flex direction="column" gap="2" width="100%">
      <Text as="label" htmlFor={id} size="2" weight="medium">
        {label}
      </Text>
      <Flex align={multiline ? "start" : "center"} gap="2" width="100%">
        {multiline ? (
          <textarea {...commonProps} rows={3} data-multiline="" />
        ) : (
          <input {...commonProps} type="text" />
        )}
        <IconButton
          type="button"
          variant="soft"
          size="2"
          className={styles.button}
          aria-label={copyLabel}
          onClick={copy}
        >
          {status === "copied" ? <Check size={16} /> : <Copy size={16} />}
        </IconButton>
      </Flex>
      <span className={styles.status} aria-live="polite">
        {status === "copied" ? copiedLabel : status === "failed" ? failedLabel : ""}
      </span>
    </Flex>
  );
}
