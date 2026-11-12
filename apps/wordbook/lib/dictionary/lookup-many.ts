import type { WordAnswer } from "./lookup";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

const GIVE_UP_MS = 20_000;

/**
 * Answers a list of words from the copy of the dictionary already on the device, then lets the Worker go
 * (RL-92). It is raised for the span of one download of `/registro` and never downloads a copy: `null` when
 * the device has none or the Worker cannot start. The box's own Worker (`useDictionary`) is untouched, so
 * opening the record or the export mounts none (RNL-08).
 */
export function lookupInstalled(words: readonly string[]): Promise<Map<string, WordAnswer> | null> {
  if (words.length === 0 || typeof Worker === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./dictionary.worker.ts", import.meta.url), { type: "module" });
    const answers = new Map<string, WordAnswer>();
    const asked = new Map<number, string>();
    // A Worker that never answers must not hold the download: the file then goes out without senses.
    const giveUp = setTimeout(() => finish(null), GIVE_UP_MS);
    function finish(result: Map<string, WordAnswer> | null) {
      clearTimeout(giveUp);
      worker.terminate();
      resolve(result);
    }

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.kind === "status") {
        if (message.status.state === "failed") finish(null);
        if (message.status.state !== "ready" || asked.size > 0) return;
        words.forEach((word, id) => {
          asked.set(id + 1, word);
          worker.postMessage({ id: id + 1, kind: "lookup", text: word } satisfies WorkerRequest);
        });
        return;
      }
      if (message.kind !== "answer") return;
      const word = asked.get(message.id);
      if (word === undefined) return;
      answers.set(word, message.answer);
      asked.delete(message.id);
      if (asked.size === 0) finish(answers);
    };
    worker.onerror = () => finish(null);
    worker.postMessage({ id: 0, kind: "boot", installedOnly: true } satisfies WorkerRequest);
  });
}
