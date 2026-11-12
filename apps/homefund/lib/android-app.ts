export const APK_CONTENT_TYPE = "application/vnd.android.package-archive";

const RELEASE_API =
  "https://api.github.com/repos/WAB-Studio/homefund-android/releases/latest";

type ReleaseAsset = { url: string; name: string; size: number };

// The latest release's `.apk` asset, or null when the release has none.
export function apkAsset(release: unknown): ReleaseAsset | null {
  const assets = (release as { assets?: unknown } | null)?.assets;
  if (!Array.isArray(assets)) return null;

  const found = assets.find(
    (asset): asset is ReleaseAsset =>
      typeof asset?.url === "string" &&
      typeof asset?.name === "string" &&
      asset.name.endsWith(".apk"),
  );
  return found ?? null;
}

// The APK of the Android app (RF-194) from its private GitHub release, streamed so the token
// never reaches the browser. The asset's own redirect to storage is followed without the token.
export async function fetchLatestApk(
  token: string,
  doFetch: typeof fetch = fetch,
): Promise<Response | null> {
  const headers = { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
  const release = await doFetch(RELEASE_API, {
    headers: { ...headers, Accept: "application/vnd.github+json" },
    cache: "no-store",
  });
  if (!release.ok) return null;

  const asset = apkAsset(await release.json());
  if (!asset) return null;

  const file = await doFetch(asset.url, {
    headers: { ...headers, Accept: "application/octet-stream" },
    cache: "no-store",
  });
  if (!file.ok || !file.body) return null;

  return new Response(file.body, {
    headers: {
      "Content-Type": APK_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${asset.name.replace(/[^\w.-]/g, "_")}"`,
      "Content-Length": String(asset.size),
      "Cache-Control": "private, no-store",
    },
  });
}

export const ANDROID_APK_PATH = "/settings/android/apk";

// The setup link the app registers: it receives the webhook and its key, so
// nothing is typed on the phone. The key is only encoded here, never stored.
export function androidSetupLink(webhookUrl: string, key: string): string {
  const query = new URLSearchParams({ url: webhookUrl, key });
  return `homefundavisos://configurar?${query.toString()}`;
}

// The Windows uploader whose menu connects Gmail (RF-192).
export const ACTIVITYWATCH_RELEASES_URL =
  "https://github.com/WAB-Studio/activitywatch/releases/latest";
