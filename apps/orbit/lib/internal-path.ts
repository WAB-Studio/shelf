// A path, never a URL. `//host` and `/\host` are protocol-relative, and a browser
// drops a tab or newline before it reads the path, so `/<tab>/host` is too. The
// check runs on the raw value and on its decoded form: either may be what a
// later hop resolves.
const SECOND_CHARACTER = /^\/(?:[^/\\\u0000-\u001f\u007f]|$)/;

export function isInternalPath(value: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  return SECOND_CHARACTER.test(value) && SECOND_CHARACTER.test(decoded);
}
