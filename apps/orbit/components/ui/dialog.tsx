"use client";

import {
  type ComponentProps,
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";
import { Dialog as RadixDialog } from "@radix-ui/themes";

// A dialog opened from state has no Trigger, so Radix has nowhere to return
// focus to and drops it on <body>. The Root remembers the element that held
// focus when `open` turned true; the Content hands it back on close. A
// dialog with a Trigger keeps Radix's own return when nothing was remembered.
const OriginContext = createContext<RefObject<HTMLElement | null> | null>(null);

export function useFocusOrigin(open: boolean | undefined) {
  const origin = useRef<HTMLElement | null>(null);

  // Layout, not passive: Radix moves focus into the content in a passive
  // effect, and the content's effects run before its parent's.
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    origin.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);

  return origin;
}

// Wired to `onCloseAutoFocus`: sends focus back to the remembered element.
export function returnFocus(origin: RefObject<HTMLElement | null> | null, event: Event) {
  const target = origin?.current;
  if (event.defaultPrevented || !target?.isConnected) return;
  event.preventDefault();
  target.focus();
}

function Root({ open, ...props }: ComponentProps<typeof RadixDialog.Root>) {
  const origin = useFocusOrigin(open);

  return (
    <OriginContext.Provider value={origin}>
      <RadixDialog.Root open={open} {...props} />
    </OriginContext.Provider>
  );
}

function Content({
  onCloseAutoFocus,
  ...props
}: ComponentProps<typeof RadixDialog.Content>) {
  const origin = useContext(OriginContext);

  return (
    <RadixDialog.Content
      {...props}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event);
        returnFocus(origin, event);
      }}
    />
  );
}

// The door to Radix Themes' Dialog: Root and Content give focus back.
export const Dialog = { ...RadixDialog, Root, Content };
