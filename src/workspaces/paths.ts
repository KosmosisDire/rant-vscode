import * as path from "node:path";

/** A path in one form for comparing: slashes forward, no trailing slash, case folded on Windows. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const impl = platform === "win32" ? path.win32 : path.posix;
  const slashed = impl.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
}

/** The workspace root that holds `file`, the deepest one when roots nest. */
export function rootOf(roots: string[], file: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const target = pathKey(file, platform);
  let best: string | undefined;
  for (const root of roots) {
    const key = pathKey(root, platform);
    if ((target === key || target.startsWith(key + "/")) && (best === undefined || key.length > pathKey(best, platform).length)) best = root;
  }
  return best;
}
