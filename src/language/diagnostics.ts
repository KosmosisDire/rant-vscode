import * as vscode from "vscode";

import { currentCli } from "../cli/current.ts";
import { CliMissing } from "../cli/exec.ts";
import type { CliError } from "../cli/errors.ts";
import { checkWorkspace } from "../workspaces/load.ts";
import { pathKey } from "../workspaces/paths.ts";
import { debounce } from "../workspaces/registry.ts";

/** Config errors of the CLI as problems on the file and line it names. */
export class RantDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("rant");
  private readonly owned = new Map<string, Set<string>>();
  private readonly pending = new Map<string, () => void>();

  /** Checks a workspace soon. Calls close together run once. */
  schedule(root: string): void {
    let run = this.pending.get(root);
    if (!run) {
      run = debounce(() => void this.check(root), 300);
      this.pending.set(root, run);
    }
    run();
  }

  async check(root: string): Promise<void> {
    const cli = currentCli();
    if (!cli) return;
    let errors: CliError[];
    try {
      errors = await checkWorkspace(cli, root);
    } catch (e) {
      if (e instanceof CliMissing) return;
      throw e;
    }
    const byFile = new Map<string, { uri: vscode.Uri; list: vscode.Diagnostic[] }>();
    for (const e of errors) {
      const uri = vscode.Uri.file(e.file);
      const entry = byFile.get(uri.toString()) ?? { uri, list: [] };
      entry.list.push(this.diagnostic(e));
      byFile.set(uri.toString(), entry);
    }
    const key = pathKey(root);
    for (const old of this.owned.get(key) ?? []) {
      if (!byFile.has(old)) this.collection.delete(vscode.Uri.parse(old));
    }
    for (const { uri, list } of byFile.values()) this.collection.set(uri, list);
    this.owned.set(key, new Set(byFile.keys()));
  }

  private diagnostic(e: CliError): vscode.Diagnostic {
    // line 0 means the whole file, which shows on the first line
    const line = Math.max(e.line, 1) - 1;
    const column = e.line === 0 ? 0 : Math.max(e.column, 1) - 1;
    const doc = vscode.workspace.textDocuments.find((d) => pathKey(d.fileName) === pathKey(e.file));
    const end = doc && line < doc.lineCount ? doc.lineAt(line).range.end.character : 1000;
    const d = new vscode.Diagnostic(new vscode.Range(line, column, line, Math.max(end, column)), e.message, vscode.DiagnosticSeverity.Error);
    d.source = "rant";
    return d;
  }

  dispose(): void {
    this.collection.dispose();
  }
}
