// Fetches the dictionary once, verifies it whole, and only then hands it to
// `writeInstalled`. Nothing here writes on a path that does not reach that
// call, so an interruption anywhere above leaves the store untouched (RL-13).
import {
  MANIFEST_PATH,
  PAYLOAD_VERSION,
  manifestSchema,
  type DictionaryManifest,
  type DictionaryPayload,
} from "./format";
import { writeInstalled } from "./store";

export type InstallProgress = { received: number; total: number | null };
export type InstallFailure = "network" | "manifest" | "integrity" | "storage";

function fail(reason: InstallFailure, message: string): Error {
  return new Error(message, { cause: reason });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function readContentLength(response: Response): number | null {
  const header = response.headers.get("content-length");
  if (header === null) return null;
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function concat(chunks: Uint8Array[], length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function toHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchOrFail(input: string, signal: AbortSignal | undefined, reason: InstallFailure): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(input, { signal });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw fail("network", `No se pudo conectar para descargar «${input}».`);
  }
  if (!response.ok) {
    throw fail(reason, `«${input}» respondió con estado ${response.status}.`);
  }
  return response;
}

export async function install(options: {
  signal?: AbortSignal;
  onProgress?: (progress: InstallProgress) => void;
}): Promise<{ manifest: DictionaryManifest; payload: DictionaryPayload }> {
  const { signal, onProgress } = options;

  const manifestResponse = await fetchOrFail(MANIFEST_PATH, signal, "manifest");
  let manifestJson: unknown;
  try {
    manifestJson = await manifestResponse.json();
  } catch (error) {
    if (isAbort(error)) throw error;
    throw fail("manifest", "El manifiesto del diccionario no es JSON válido.");
  }
  const parsed = manifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    throw fail("manifest", "El manifiesto del diccionario no tiene la forma esperada.");
  }
  const manifest = parsed.data;

  const assetResponse = await fetchOrFail(manifest.asset.path, signal, "network");
  if (!assetResponse.body) {
    throw fail("network", "La respuesta del diccionario no trae contenido.");
  }

  // The server answers this asset gzipped and chunked, so `content-length`
  // is never present (RL-12's honest edge). The manifest already carries
  // the uncompressed size, and `fetch` hands the reader decoded bytes, so
  // `received` grows on the same basis as `manifest.asset.bytes` throughout
  // — the fallback is exact, not an estimate.
  const total = readContentLength(assetResponse) ?? manifest.asset.bytes;
  const reader = assetResponse.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  // Read chunk by chunk so `onProgress` reflects bytes actually arrived, not
  // an estimate. An abort here rejects the read and propagates untouched.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.({ received, total });
  }

  if (received !== manifest.asset.bytes) {
    throw fail("integrity", "El diccionario descargado no tiene el tamaño esperado.");
  }

  const bytes = concat(chunks, received);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  if (toHex(digest) !== manifest.asset.sha256) {
    throw fail("integrity", "El diccionario descargado no coincide con su huella.");
  }

  const payloadText = new TextDecoder().decode(bytes);
  let payloadJson: unknown;
  try {
    payloadJson = JSON.parse(payloadText);
  } catch {
    throw fail("integrity", "El diccionario descargado no es JSON válido.");
  }
  const payload = payloadJson as DictionaryPayload;
  if (typeof payload !== "object" || payload === null || payload.version !== PAYLOAD_VERSION) {
    throw fail("integrity", "La versión del diccionario descargado no es compatible.");
  }

  try {
    await writeInstalled(manifest, payloadText);
  } catch {
    throw fail("storage", "No se pudo guardar el diccionario en el dispositivo.");
  }

  return { manifest, payload };
}
