import * as path from "node:path";

export interface Cli {
  /** What to execute. */
  exe: string;
  /** What a terminal line shows: the bare name when PATH finds it. */
  display: string;
}

export interface LocateOptions {
  setting: string;
  pathEnv: string | undefined;
  home: string;
  platform: NodeJS.Platform;
  exists: (file: string) => boolean;
}

/** The setting when set, else `rant` on PATH, else ~/.rant/bin/rant. */
export function locateCli(o: LocateOptions): Cli | undefined {
  const p = o.platform === "win32" ? path.win32 : path.posix;
  const name = o.platform === "win32" ? "rant.exe" : "rant";
  const setting = o.setting.trim();
  if (setting) {
    const exe = setting.startsWith("~/") || setting.startsWith("~\\") ? p.join(o.home, setting.slice(2)) : setting;
    return o.exists(exe) ? { exe, display: exe } : undefined;
  }
  const dirs = (o.pathEnv ?? "").split(o.platform === "win32" ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    const exe = p.join(dir, name);
    if (o.exists(exe)) return { exe, display: "rant" };
  }
  const home = p.join(o.home, ".rant", "bin", name);
  return o.exists(home) ? { exe: home, display: home } : undefined;
}
