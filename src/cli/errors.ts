/** One error line of the CLI. line and column are one based, 0 means the whole file. */
export interface CliError {
  file: string;
  line: number;
  column: number;
  message: string;
}

// `error: <file>:<line>:<col>: <message>` or `error: <file>: <message>`, only for config files
const LOCATED = /^error: (.+?\.(?:rant|run)):(?:(\d+):(\d+):)? (.+)$/;

/** The errors that name a config file. Errors with no file are not about a file and are left out. */
export function parseErrors(text: string): CliError[] {
  const out: CliError[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LOCATED.exec(raw.trim());
    if (!m) continue;
    const [, file, line, column, message] = m;
    out.push({ file: file ?? "", line: Number(line ?? 0), column: Number(column ?? 0), message: message ?? "" });
  }
  return out;
}

/** The message of the first `error:` line, for a one line status. */
export function firstError(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((l) => l.startsWith("error: "));
  return line?.slice("error: ".length);
}
