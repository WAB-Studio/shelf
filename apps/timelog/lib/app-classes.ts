import type { AppTime } from "@/lib/queries";

// What an app is for. Classes describe where the time went; none of them is better than another.
export type AppClass = "code" | "browser" | "comms" | "leisure" | "system" | "other";

export const APP_CLASSES: AppClass[] = ["code", "browser", "comms", "leisure", "system", "other"];

const CLAUDE_APP = "Claude";

const CLASS_OF: Record<string, AppClass> = {
  "VS Code": "code",
  "Visual Studio": "code",
  "IntelliJ IDEA": "code",
  Terminal: "code",
  Java: "code",
  Postman: "code",
  "Docker Desktop": "code",
  Edge: "browser",
  Chrome: "browser",
  Firefox: "browser",
  Brave: "browser",
  Slack: "comms",
  Discord: "comms",
  Teams: "comms",
  Zoom: "comms",
  WhatsApp: "comms",
  Outlook: "comms",
  Spotify: "leisure",
  Steam: "leisure",
  "Riot Client": "leisure",
  VLC: "leisure",
  "MPC-HC": "leisure",
};

// The class of an app by its readable name; one not listed is «other». Windows' own noise is `systemName`.
export function appClass(name: string, systemName: string): AppClass {
  return name === systemName ? "system" : (CLASS_OF[name] ?? "other");
}

// The colour an app's row draws in: its class, except the Claude desktop app, which keeps the orange its Claude card gives it.
export function appTone(name: string, systemName: string): AppClass | "claudeApp" {
  return name === CLAUDE_APP ? "claudeApp" : appClass(name, systemName);
}

// The day's time by class, longest first; a class with nothing is absent.
export function timeByClass(apps: AppTime[], systemName: string): { kind: AppClass; seconds: number }[] {
  const seconds = new Map<AppClass, number>();
  for (const one of apps) {
    const kind = appClass(one.app, systemName);
    seconds.set(kind, (seconds.get(kind) ?? 0) + one.seconds);
  }
  return [...seconds]
    .map(([kind, total]) => ({ kind, seconds: total }))
    .filter((one) => one.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds || APP_CLASSES.indexOf(a.kind) - APP_CLASSES.indexOf(b.kind));
}
