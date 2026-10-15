import * as path from "node:path";
import * as vscode from "vscode";

import { requireCli } from "../../cli/current.ts";
import { CliMissing, runCli } from "../../cli/exec.ts";
import { firstError } from "../../cli/errors.ts";
import { parseSource } from "../../cli/parse.ts";
import { runInTerminal } from "../../terminal.ts";
import { actionArgs, LANGUAGES, newArgs, PRESET_KINDS, validName } from "./actions.ts";
import type { Action, Language, PresetKind } from "./actions.ts";
import type { WorkspacesView } from "./provider.ts";
import type { TreeNode } from "./tree.ts";

async function pickRoot(view: WorkspacesView): Promise<string | undefined> {
  const roots = view.roots;
  if (roots.length <= 1) return roots[0];
  const pick = await vscode.window.showQuickPick(
    roots.map((r) => ({ label: path.basename(r), description: r, root: r })),
    { placeHolder: "Which workspace" },
  );
  return pick?.root;
}

async function pickFolder(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Create Here",
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
  });
  return picked?.[0]?.fsPath;
}

/** `rant new` for a kind and a name, into the folder the row names or one the user picks. */
async function newFromPreset(view: WorkspacesView, row?: TreeNode): Promise<void> {
  const kind = await vscode.window.showQuickPick(
    PRESET_KINDS.map((k) => ({ label: k.kind, detail: k.detail })),
    { placeHolder: "What to make" },
  );
  if (!kind) return;
  const preset = kind.label as PresetKind;

  let language: Language | undefined;
  if (preset === "workspace" || preset === "package") {
    language = (await vscode.window.showQuickPick([...LANGUAGES], { placeHolder: "Language" })) as Language | undefined;
    if (!language) return;
  }
  const name = await vscode.window.showInputBox({ prompt: `Name of the ${preset}`, validateInput: validName });
  if (!name) return;

  let folder: string | undefined;
  if (preset === "workspace") folder = await pickFolder();
  else if (preset === "node" && row?.kind === "package" && row.path) folder = row.path;
  else folder = row?.root ?? (await pickRoot(view));
  if (!folder) return;

  const cli = requireCli();
  if (cli) runInTerminal(cli, folder, newArgs(preset, name, language));
}

async function openSource(row: TreeNode): Promise<void> {
  if (row.kind === "group" && row.path) return show(row.path);
  const cli = requireCli();
  if (!cli) return;
  const r = await runCli(cli, ["info", "node", row.ref, "--json"], row.root);
  const target = r.code === 0 ? parseSource(r.stdout, row.root) : undefined;
  if (!target) {
    void vscode.window.showWarningMessage(`No source file known for ${row.ref}. ${firstError(r.stderr) ?? ""}`.trim());
    return;
  }
  await show(target.file, target.find);
}

async function show(file: string, find?: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(doc);
  const at = find ? doc.getText().indexOf(find) : -1;
  if (at < 0) return;
  const pos = doc.positionAt(at);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

export function registerCommands(view: WorkspacesView, refreshAll: () => Promise<void>): vscode.Disposable[] {
  const act = (action: Action) => (row?: TreeNode) => {
    const args = row && actionArgs(action, row);
    if (!row || !args) return;
    const cli = requireCli();
    if (cli) runInTerminal(cli, row.root, args);
  };
  return [
    vscode.commands.registerCommand("rant.refresh", refreshAll),
    vscode.commands.registerCommand("rant.new", (row?: TreeNode) => newFromPreset(view, row)),
    vscode.commands.registerCommand("rant.build", act("build")),
    vscode.commands.registerCommand("rant.start", act("start")),
    vscode.commands.registerCommand("rant.stop", act("stop")),
    vscode.commands.registerCommand("rant.restart", act("restart")),
    vscode.commands.registerCommand("rant.openSource", async (row?: TreeNode) => {
      if (!row) return;
      try {
        await openSource(row);
      } catch (e) {
        if (!(e instanceof CliMissing)) void vscode.window.showErrorMessage(String(e));
      }
    }),
    vscode.commands.registerCommand("rant.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "rant.cliPath"),
    ),
  ];
}
