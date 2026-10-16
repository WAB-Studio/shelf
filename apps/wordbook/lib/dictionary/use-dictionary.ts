"use client";

// One Worker per mounted hook. It never renders an answer itself — it hands
// back promises keyed by the query the caller asked for, so a stale reply
// can never land on a newer one.
import { useCallback, useEffect, useRef, useState } from "react";

import type { WordAnswer } from "./lookup";
import type { DictionaryStatus, WorkerRequest, WorkerResponse } from "./worker-protocol";

type Resolver =
  | { kind: "lookup"; resolve: (value: WordAnswer) => void; reject: (reason: Error) => void }
  | { kind: "suggest"; resolve: (value: string[]) => void; reject: (reason: Error) => void }
  | { kind: "has"; resolve: (value: boolean) => void; reject: (reason: Error) => void };

export type UseDictionaryResult = {
  status: DictionaryStatus;
  lookup(text: string): Promise<WordAnswer>;
  suggest(prefix: string, limit: number): Promise<string[]>;
  has(text: string): Promise<boolean>;
  retry(): void;
};

function unavailable(): Error {
  return new Error("El diccionario todavía no está disponible.");
}

export function useDictionary(): UseDictionaryResult {
  const [status, setStatus] = useState<DictionaryStatus>({ state: "booting" });
  const workerRef = useRef<Worker | null>(null);
  const resolversRef = useRef(new Map<number, Resolver>());
  const nextIdRef = useRef(0);

  useEffect(() => {
    const worker = new Worker(new URL("./dictionary.worker.ts", import.meta.url), { type: "module" });
    const resolvers = resolversRef.current;
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;

      if (message.kind === "status") {
        // `status` alone drives the retry control. A `failed` status settles
        // nothing here: the worker keeps every queued request and answers it
        // once a later `retry` reaches `ready`, so a pending resolver stays
        // in the map across the failure.
        setStatus(message.status);
        return;
      }

      const pending = resolvers.get(message.id);
      if (!pending) return;
      resolvers.delete(message.id);
      switch (message.kind) {
        case "answer":
          if (pending.kind === "lookup") pending.resolve(message.answer);
          break;
        case "suggestions":
          if (pending.kind === "suggest") pending.resolve(message.items);
          break;
        case "has":
          if (pending.kind === "has") pending.resolve(message.value);
          break;
      }
    };

    worker.onerror = () => setStatus({ state: "failed", reason: "network" });

    const boot: WorkerRequest = { id: nextIdRef.current++, kind: "boot" };
    worker.postMessage(boot);

    return () => {
      worker.terminate();
      workerRef.current = null;
      resolvers.clear();
    };
  }, []);

  const lookup = useCallback((text: string): Promise<WordAnswer> => {
    return new Promise((resolve, reject) => {
      const worker = workerRef.current;
      if (!worker) {
        reject(unavailable());
        return;
      }
      const id = nextIdRef.current++;
      resolversRef.current.set(id, { kind: "lookup", resolve, reject });
      worker.postMessage({ id, kind: "lookup", text } satisfies WorkerRequest);
    });
  }, []);

  const suggestWords = useCallback((prefix: string, limit: number): Promise<string[]> => {
    return new Promise((resolve, reject) => {
      const worker = workerRef.current;
      if (!worker) {
        reject(unavailable());
        return;
      }
      const id = nextIdRef.current++;
      resolversRef.current.set(id, { kind: "suggest", resolve, reject });
      worker.postMessage({ id, kind: "suggest", prefix, limit } satisfies WorkerRequest);
    });
  }, []);

  const has = useCallback((text: string): Promise<boolean> => {
    return new Promise((resolve, reject) => {
      const worker = workerRef.current;
      if (!worker) {
        reject(unavailable());
        return;
      }
      const id = nextIdRef.current++;
      resolversRef.current.set(id, { kind: "has", resolve, reject });
      worker.postMessage({ id, kind: "has", text } satisfies WorkerRequest);
    });
  }, []);

  const retry = useCallback(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const id = nextIdRef.current++;
    worker.postMessage({ id, kind: "retry" } satisfies WorkerRequest);
  }, []);

  return { status, lookup, suggest: suggestWords, has, retry };
}
