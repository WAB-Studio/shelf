// A yes/no a device keeps in storage, readable without React and heard across tabs.
// Absent, or storage throwing, reads as no.
export function createStoredFlag(key: string) {
  const listeners = new Set<() => void>();

  function read(): boolean {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  }

  function write(on: boolean): void {
    try {
      if (on) localStorage.setItem(key, "1");
      else localStorage.removeItem(key);
    } catch {
      // Storage unavailable; the value holds for this page's life only.
    }
    for (const listener of listeners) listener();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) listener();
    };
    window.addEventListener("storage", onStorage);

    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  }

  return { read, write, subscribe };
}
