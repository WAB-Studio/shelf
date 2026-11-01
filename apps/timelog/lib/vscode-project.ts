import type { WindowTime } from "@/lib/queries";

export type ProjectTime = { project: string; seconds: number };

// Editors whose title reads «file — folder — product»: VS Code, its Insiders build and OSS builds, Cursor.
const EDITORS = new Set(["code", "code - insiders", "code - oss", "codium", "cursor"]);
const SEPARATOR = /\s+[-\u2013\u2014]\s+/;
const PRODUCT = /\s+[-\u2013\u2014]\s+(?:Visual Studio Code(?:\s+[-\u2013\u2014]\s+Insiders)?|Code - OSS|VSCodium|Cursor)$/i;
// «[WSL: Ubuntu]», «[Remote - SSH: host]», «[Dev Container: x]» and «(Workspace)» belong to the window, not to the folder's name.
const DECORATION = /\s*\[(?:WSL|Remote|SSH|Dev Container|Codespaces)[^\]]*\]|\s*\(Workspace\)/gi;
const FILE_NAME = /\.[A-Za-z0-9]{1,8}$/;

// The workspace folder a VS Code-family window title names, or null: not an editor, no folder open, or a screen
// of the editor itself («Welcome», «Settings»). With two parts the first is the folder unless it reads as a file.
export function projectOfWindow(app: string, title: string): string | null {
  if (!EDITORS.has(app.toLowerCase().replace(/\.exe$/, ""))) return null;
  const bare = title.replace(/^\[Extension Development Host\]\s*/, "").replace(DECORATION, "");
  const product = PRODUCT.exec(bare);
  if (product === null) return null;
  const parts = bare.slice(0, product.index).split(SEPARATOR);
  const folder = (parts.at(-1) ?? "").replace(/^[\u25CF\u2022]\s*/, "").trim();
  if (parts.length === 1 && FILE_NAME.test(folder)) return null;
  return folder === "" || /^(welcome|settings|get started|extension:.*)$/i.test(folder) ? null : folder;
}

// Seconds per project over a day's window rows, longest first.
export function projectsOf(windows: WindowTime[]): ProjectTime[] {
  const seconds = new Map<string, number>();
  for (const one of windows) {
    const project = projectOfWindow(one.app, one.title);
    if (project !== null) seconds.set(project, (seconds.get(project) ?? 0) + one.seconds);
  }
  return [...seconds].map(([project, total]) => ({ project, seconds: total })).sort((a, b) => b.seconds - a.seconds || a.project.localeCompare(b.project));
}
