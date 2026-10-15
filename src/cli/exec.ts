import { execFile } from "node:child_process";

import type { Cli } from "./locate.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class CliMissing extends Error {
  constructor(exe: string) {
    super(`cannot run ${exe}`);
  }
}

/** Runs the CLI to the end. A failing exit code is a result, a missing program or a timeout is an error. */
export function runCli(cli: Cli, args: string[], cwd: string, timeoutMs = 15000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cli.exe,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === "ENOENT" || e.code === "EACCES") return reject(new CliMissing(cli.exe));
        if (e.killed) return reject(new Error(`rant ${args.join(" ")} timed out`));
        resolve({ code: typeof e.code === "number" ? e.code : 1, stdout, stderr });
      },
    );
  });
}
