// A Claude Code project folder is its path with every separator turned into a dash
// («-home-me-projects-shelf», «C--Users-me-repos-shelf»). The path cannot be told back from the dashes, so the
// name is what follows the folder people keep their projects in, else the folder as written.
const KEPT_IN = /-(?:projects|repos|code|src|dev|work)-(.+)$/i;

export function projectName(folder: string): string {
  const kept = KEPT_IN.exec(folder)?.[1];
  return kept ?? (folder.replace(/^[A-Za-z]?-+/, "") || folder);
}
