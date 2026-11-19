"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { IconButton, SuggestPanel, suggestOptionId, TextField, type SuggestRow } from "@/components/ui";

// The one input the whole app answers from: no submit, no mode, never
// disabled — a status the box cannot read must never take its focus (RL-77).
// The panel of suggestions hangs under it; ↑ ↓ move through its rows, Enter opens the one lit and Esc
// closes the panel until the text changes.
export function SearchBox({
  value,
  onChange,
  rows,
}: {
  value: string;
  onChange: (text: string) => void;
  rows: readonly SuggestRow[];
}) {
  const t = useTranslations("search");
  const tWord = useTranslations("word");
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  // The text Esc closed the panel for, and the row lit for one set of rows: both reset themselves
  // the moment the text or the rows change.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const rowsKey = rows.map((row) => row.key).join("\n");
  const [lit, setLit] = useState<{ key: string; index: number }>({ key: "", index: 0 });
  const active = lit.key === rowsKey ? lit.index : 0;
  const open = rows.length > 0 && closedFor !== value;

  // Grabbed once, on mount, and never again: nothing later in the install
  // is allowed to steal it back.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (!open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setLit({ key: rowsKey, index: (active + step + rows.length) % rows.length });
    } else if (event.key === "Enter") {
      event.preventDefault();
      onChange(rows[active].word);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setClosedFor(value);
    }
  }

  return (
    <SuggestPanel
      id={listId}
      label={tWord("suggestions")}
      rows={rows}
      active={active}
      open={open}
      hintKeys={t("hintKeys")}
      hintClose={t("hintClose")}
      onPick={onChange}
    >
      <TextField.Root
        ref={inputRef}
        size="3"
        edge
        pill
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("placeholder")}
        aria-label={t("label")}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? suggestOptionId(listId, active) : undefined}
        aria-autocomplete="list"
        lang="en"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
      >
        <TextField.Slot side="left">
          <Search size={18} aria-hidden="true" />
        </TextField.Slot>
        {value.length > 0 && (
          <TextField.Slot side="right">
            <IconButton
              type="button"
              size="2"
              variant="ghost"
              color="gray"
              aria-label={t("clear")}
              onClick={() => {
                onChange("");
                inputRef.current?.focus();
              }}
            >
              <X size={16} />
            </IconButton>
          </TextField.Slot>
        )}
      </TextField.Root>
    </SuggestPanel>
  );
}
