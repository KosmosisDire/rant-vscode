import * as path from "node:path";
import * as vscode from "vscode";

import { shellLine } from "./cli/shell.ts";
import type { Cli } from "./cli/locate.ts";
import { pathKey } from "./workspaces/paths.ts";

const roots = new Map<vscode.Terminal, string>();

function terminalFor(root: string): vscode.Terminal {
  const name = `Rant: ${path.basename(root)}`;
  const open = vscode.window.terminals.find((t) => {
    const cwd = (t.creationOptions as vscode.TerminalOptions).cwd;
    const dir = typeof cwd === "string" ? cwd : cwd?.fsPath;
    return t.name === name && t.exitStatus === undefined && dir !== undefined && pathKey(dir) === pathKey(root);
  });
  const terminal = open ?? vscode.window.createTerminal({ name, cwd: root });
  roots.set(terminal, root);
  return terminal;
}

/** Runs the CLI in a terminal named after the workspace, started in its folder. */
export function runInTerminal(cli: Cli, root: string, args: string[]): void {
  const terminal = terminalFor(root);
  terminal.show(true);
  terminal.sendText(shellLine(cli.display, args, vscode.env.shell));
}

/** Calls back with the workspace root when a command in one of our terminals ends. */
export function onCommandDone(callback: (root: string) => void): vscode.Disposable {
  return vscode.window.onDidEndTerminalShellExecution((e) => {
    const root = roots.get(e.terminal);
    if (root) callback(root);
  });
}
