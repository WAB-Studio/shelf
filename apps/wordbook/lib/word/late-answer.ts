"use client";

import { useEffect, useRef, useState } from "react";
import type { ZodType } from "zod";

// What a request made after the answer was already on screen came to. Only
// `resolved` and `declined` are the server's word; `unreached` says nothing
// about the server, so nothing may remember it.
export type LateResult<T> =
  | { kind: "resolved"; value: T }
  | { kind: "declined" }
  | { kind: "unreached" };

export type LateState<T> = { kind: "idle" } | { kind: "pending" } | LateResult<T>;

const IDLE = { kind: "idle" } as const;
const PENDING = { kind: "pending" } as const;

export async function askLate<T>(
  endpoint: string,
  body: unknown,
  schema: ZodType<T>,
  signal: AbortSignal,
): Promise<LateResult<T>> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (response.status === 200) {
      const parsed = schema.safeParse(await response.json());
      return parsed.success ? { kind: "resolved", value: parsed.data } : { kind: "unreached" };
    }
    // 204 is the server's deliberate absence (no key, a cap, a refusal); a
    // 4xx is a request it will answer the same way again.
    return response.status === 204 || (response.status >= 400 && response.status < 500)
      ? { kind: "declined" }
      : { kind: "unreached" };
  } catch {
    return { kind: "unreached" };
  }
}

export function remembers<T>(result: LateResult<T>): boolean {
  return result.kind === "resolved" || result.kind === "declined";
}

// `cache` is read from render, never mirrored into state in the effect body:
// only a request now in flight and one that just settled reach `setState`,
// both from a timer or a settled promise.
export function useLateAnswer<T>(
  key: string | null,
  ask: (signal: AbortSignal) => Promise<LateResult<T>>,
  cache: Map<string, LateResult<T>>,
  debounceMs: number,
): LateState<T> {
  const [asked, setAsked] = useState<string | null>(null);
  const [settled, setSettled] = useState<{ key: string; result: LateResult<T> } | null>(null);
  // The latest `ask` without making it an effect dependency: a caller passes
  // a fresh closure every render.
  const askRef = useRef(ask);
  useEffect(() => {
    askRef.current = ask;
  });

  useEffect(() => {
    if (key === null || cache.has(key)) return;

    let controller: AbortController | null = null;
    const timer = setTimeout(() => {
      const own = new AbortController();
      controller = own;
      setAsked(key);
      void askRef.current(own.signal).then((result) => {
        // A request the next change aborted lands nowhere and is not remembered.
        if (own.signal.aborted) return;
        if (remembers(result)) cache.set(key, result);
        setSettled({ key, result });
      });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller?.abort();
    };
  }, [key, cache, debounceMs]);

  if (key === null) return IDLE;
  const cached = cache.get(key);
  if (cached) return cached;
  if (settled && settled.key === key) return settled.result;
  return asked === key ? PENDING : IDLE;
}
