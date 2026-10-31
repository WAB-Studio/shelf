import type { DictionaryManifest, DictionaryPayload } from "./format";

export type DictionaryCopy = { manifest: DictionaryManifest; payload: DictionaryPayload };

type Deps = {
  read: () => Promise<(DictionaryCopy & { stale: boolean }) | null>;
  // `quiet` is a refresh behind a copy that already answers: no progress is shown for it.
  install: (quiet: boolean) => Promise<DictionaryCopy>;
  ready: (copy: DictionaryCopy) => void;
};

// An installed copy answers at once, even one from an older version (RL-35). A stale one is replaced only
// after the new copy has downloaded and been stored; a refresh that fails leaves the old copy in place.
export async function resolveDictionary({ read, install, ready }: Deps): Promise<void> {
  const installed = await read();
  if (installed === null) {
    ready(await install(false));
    return;
  }
  ready(installed);
  if (!installed.stale) return;
  try {
    ready(await install(true));
  } catch {
    // The old copy keeps answering; the next boot tries again.
  }
}
