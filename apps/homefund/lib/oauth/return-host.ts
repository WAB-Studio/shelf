// `URL.host` keeps the port unless it is the scheme's default, brackets IPv6,
// lower-cases, and leaves credentials, path, query and fragment out.
export function returnHost(uri: string): string {
  return new URL(uri).host;
}
