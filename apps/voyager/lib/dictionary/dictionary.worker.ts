// The install, the payload and the index all live in this one thread, so a
// lookup on the main thread is a message, never a transaction (RL-35,
// RNL-01). `readInstalled` decides "installing" versus "ready" alone
// (RL-13); this file never guesses at the store's state.
import { buildIndex, type DictionaryIndex } from "./index-build";
import type { DictionaryManifest, DictionaryPayload } from "./format";
import { install, type InstallFailure, type InstallProgress } from "./install";
import { hasEntry, lookupWord, suggest } from "./lookup";
import { readInstalled } from "./store";
import type { DictionaryStatus, WorkerRequest, WorkerResponse } from "./worker-protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

type QueuableRequest =
  | (WorkerRequest & { kind: "lookup" })
  | (WorkerRequest & { kind: "suggest" })
  | (WorkerRequest & { kind: "has" });

let index: DictionaryIndex | null = null;
let bootStarted = false;
// A request that lands before `ready` waits here — never rejected, answered
// exactly once when the index is built.
const queue: QueuableRequest[] = [];

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  switch (request.kind) {
    case "boot":
      if (!bootStarted) {
        bootStarted = true;
        void runInstallFlow();
      }
      break;
    case "retry":
      void runInstallFlow();
      break;
    case "lookup":
    case "suggest":
    case "has":
      if (index) answer(request, index);
      else queue.push(request);
      break;
  }
};

function post(response: WorkerResponse): void {
  ctx.postMessage(response);
}

function postStatus(status: DictionaryStatus): void {
  post({ kind: "status", status });
}

// A fetch reader loop calls `onProgress` once per chunk — far more often
// than a progress bar needs to repaint. Cap it at ten posts a second.
function throttled(minIntervalMs: number, fn: (progress: InstallProgress) => void) {
  let last = -Infinity;
  return (progress: InstallProgress) => {
    const now = Date.now();
    if (now - last < minIntervalMs) return;
    last = now;
    fn(progress);
  };
}

function toFailure(error: unknown): InstallFailure {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause === "network" || cause === "manifest" || cause === "integrity" || cause === "storage") {
    return cause;
  }
  return "storage";
}

async function runInstallFlow(): Promise<void> {
  try {
    const installed = await readInstalled();
    let manifest: DictionaryManifest;
    let payload: DictionaryPayload;
    if (installed) {
      manifest = installed.manifest;
      payload = installed.payload;
    } else {
      const onProgress = throttled(100, (progress) => postStatus({ state: "installing", progress }));
      onProgress({ received: 0, total: null });
      const result = await install({ onProgress });
      manifest = result.manifest;
      payload = result.payload;
    }
    const built = buildIndex(payload);
    index = built;
    postStatus({ state: "ready", manifest });
    flushQueue(built);
  } catch (error) {
    index = null;
    postStatus({ state: "failed", reason: toFailure(error) });
  }
}

function flushQueue(builtIndex: DictionaryIndex): void {
  const pending = queue.splice(0, queue.length);
  for (const request of pending) answer(request, builtIndex);
}

function answer(request: QueuableRequest, builtIndex: DictionaryIndex): void {
  switch (request.kind) {
    case "lookup":
      post({ id: request.id, kind: "answer", answer: lookupWord(builtIndex, request.text) });
      break;
    case "suggest":
      post({ id: request.id, kind: "suggestions", items: suggest(builtIndex, request.prefix, request.limit) });
      break;
    case "has":
      post({ id: request.id, kind: "has", value: hasEntry(builtIndex, request.text) });
      break;
  }
}
