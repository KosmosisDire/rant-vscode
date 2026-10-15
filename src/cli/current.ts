import { existsSync } from "node:fs";
import * as os from "node:os";
import * as vscode from "vscode";

import { locateCli } from "./locate.ts";
import type { Cli } from "./locate.ts";

/** The CLI the settings and PATH point at, or undefined when there is none. */
export function currentCli(): Cli | undefined {
  return locateCli({
    setting: vscode.workspace.getConfiguration("rant").get<string>("cliPath", ""),
    pathEnv: process.env.PATH ?? process.env.Path,
    home: os.homedir(),
    platform: process.platform,
    exists: existsSync,
  });
}

/** The CLI, or a message with the fix when it cannot be found. */
export function requireCli(): Cli | undefined {
  const cli = currentCli();
  if (!cli) void tellMissing();
  return cli;
}

async function tellMissing(): Promise<void> {
  const open = "Open Settings";
  const pick = await vscode.window.showErrorMessage(
    "The rant command line tool was not found. Install it from https://github.com/KosmosisDire/rant-cli or set the setting rant.cliPath.",
    open,
  );
  if (pick === open) await vscode.commands.executeCommand("rant.openSettings");
}
