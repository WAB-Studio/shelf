// The only door to navigator.storage: true = kept, false = the browser may evict, null = no API or it failed.
function storageManager(): StorageManager | null {
  if (typeof navigator === "undefined") return null;
  return navigator.storage ?? null;
}

export async function storageKept(): Promise<boolean | null> {
  const manager = storageManager();
  if (!manager || typeof manager.persisted !== "function") return null;
  try {
    return await manager.persisted();
  } catch {
    return null;
  }
}

export async function askToKeepStorage(): Promise<boolean | null> {
  const manager = storageManager();
  if (!manager || typeof manager.persist !== "function") return null;
  try {
    return await manager.persist();
  } catch {
    return null;
  }
}
