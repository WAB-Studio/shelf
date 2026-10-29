const CLEAR_ENDPOINT = "/api/log/clear";

/**
 * Wipes every lookup this reader's account holds, every device that ever
 * copied to it included (`RegistroVaciarConfirmar`'s "vaciar aquí y en mi
 * cuenta"). Never touches this device's own `lookups` or `sync` state —
 * `ClearPanel` calls `clearLocalLookups` itself, and only once this
 * resolves `true`, so a failed network call never costs a row this device
 * had not yet agreed to lose. Never throws: a cut connection reads the same
 * as a rejected request.
 */
export async function clearAccountLookups(): Promise<boolean> {
  try {
    const response = await fetch(CLEAR_ENDPOINT, { method: "DELETE" });
    return response.ok;
  } catch {
    return false;
  }
}
