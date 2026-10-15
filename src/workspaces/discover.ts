import * as fs from "node:fs/promises";
import * as path from "node:path";

export const WORKSPACE_FILE = "workspace.rant";

/** Folders the CLI skips, plus the usual output folders. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".rant",
  "node_modules",
  "_deps",
  "build",
  "bin",
  "dist",
  "target",
  "out",
]);

/** True when a path inside a workspace folder passes through a skipped folder. */
export function inSkippedDir(relative: string): boolean {
  return relative.split(/[\\/]/).some((part) => SKIPPED_DIRS.has(part));
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The nearest folder at or above `start` that holds a workspace.rant. */
async function workspaceAbove(start: string): Promise<string | undefined> {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (await isFile(path.join(dir, WORKSPACE_FILE))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

async function walk(dir: string, found: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isFile() && e.name === WORKSPACE_FILE)) {
    found.add(dir);
    return;
  }
  // a venv or a CMake build tree holds fetched sources, never a workspace
  if (entries.some((e) => e.isFile() && (e.name === "pyvenv.cfg" || e.name === "CMakeCache.txt"))) return;
  for (const e of entries) {
    if (e.isDirectory() && !SKIPPED_DIRS.has(e.name)) await walk(path.join(dir, e.name), found);
  }
}

/** Every workspace root in or above the open folders, sorted. Nothing is looked for inside a workspace. */
export async function discoverWorkspaces(folders: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const folder of folders) {
    const above = await workspaceAbove(path.resolve(folder));
    if (above) found.add(above);
    else await walk(path.resolve(folder), found);
  }
  return [...found].sort();
}
