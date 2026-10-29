// Shared by the worker and the hook — no browser API, no side of the
// boundary reaching into the other's code. `WorkerRequest` always carries an
// `id`; `status` is the one response with none, since it is never a reply.
import type { DictionaryManifest } from "./format";
import type { InstallFailure, InstallProgress } from "./install";
import type { WordAnswer } from "./lookup";

export type DictionaryStatus =
  | { state: "booting" }
  | { state: "installing"; progress: InstallProgress }
  | { state: "ready"; manifest: DictionaryManifest }
  | { state: "failed"; reason: InstallFailure };

export type WorkerRequest = { id: number } & (
  | { kind: "boot" }
  | { kind: "retry" }
  | { kind: "lookup"; text: string }
  | { kind: "suggest"; prefix: string; limit: number }
  | { kind: "has"; text: string }
);

export type WorkerResponse =
  | { id: number; kind: "answer"; answer: WordAnswer }
  | { id: number; kind: "suggestions"; items: string[] }
  | { id: number; kind: "has"; value: boolean }
  | { kind: "status"; status: DictionaryStatus };
