// The Android companion app that forwards bank notifications to the webhook.
export const ANDROID_APP_RELEASES_URL =
  "https://github.com/WAB-Studio/homefund-android/releases/latest";

// The setup link the app registers: it receives the webhook and its key, so
// nothing is typed on the phone. The key is only encoded here, never stored.
export function androidSetupLink(webhookUrl: string, key: string): string {
  const query = new URLSearchParams({ url: webhookUrl, key });
  return `homefundavisos://configurar?${query.toString()}`;
}
