// The hosts this app answers on. The connector URL a person types may be the old production address while
// `NEXT_PUBLIC_SITE_URL` already names the new one; issuer, resource metadata and the resource a request names
// all follow the host the request came on, for these hosts and no other.
const ALSO_SERVED = ["our-piggy-bank.vercel.app"];

export function servedOrigins(siteUrl: string): string[] {
  const site = new URL(siteUrl);

  return [site.origin, ...ALSO_SERVED.filter((host) => host !== site.host).map((host) => `https://${host}`)];
}

// The origin to answer with: the request's own when this app serves it, else the configured one.
export function servedOrigin(host: string | null, siteUrl: string): string {
  const origins = servedOrigins(siteUrl);

  return origins.find((origin) => new URL(origin).host === host) ?? origins[0];
}

export function requestHost(request: { headers: { get(name: string): string | null }; url: string }): string {
  return request.headers.get("host") ?? new URL(request.url).host;
}
