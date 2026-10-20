import type { LogLine } from "rant-middleware";

/** A mesh log line as text: the sender's time, the level, Rant's own lines marked, the node when asked. */
export function meshText(l: Pick<LogLine, "level" | "origin" | "node" | "text" | "wallUs">, withNode: boolean): string {
  const at = new Date(l.wallUs / 1000).toISOString().slice(11, 23);
  const who = [withNode ? l.node : "", l.origin === "rant" ? "(Rant)" : ""].filter(Boolean).join(" ");
  return `${at} ${l.level.toUpperCase().padEnd(5)} ${who ? `${who}: ` : ""}${l.text}`;
}

/** The line in one record of `rant log --json`, undefined for anything else. */
export function outputLine(record: string): string | undefined {
  try {
    const r = JSON.parse(record) as { line?: unknown };
    return typeof r.line === "string" ? r.line : undefined;
  } catch {
    return undefined;
  }
}
