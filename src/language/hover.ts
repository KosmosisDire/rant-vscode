import * as vscode from "vscode";

import type { WorkspaceData } from "../workspaces/load.ts";
import { describe, knownFrom } from "./context.ts";
import { fileKindOf } from "./vocabulary.ts";

export class RantHover implements vscode.HoverProvider {
  private readonly workspaceOf: (file: string) => WorkspaceData | undefined;

  constructor(workspaceOf: (file: string) => WorkspaceData | undefined) {
    this.workspaceOf = workspaceOf;
  }

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const kind = fileKindOf(doc.fileName);
    if (!kind) return undefined;
    const w = this.workspaceOf(doc.fileName);
    const known = w && !w.error ? knownFrom(w, doc.fileName) : undefined;
    const text = describe(kind, doc.getText(), doc.offsetAt(pos), known);
    return text ? new vscode.Hover(new vscode.MarkdownString(text), doc.getWordRangeAtPosition(pos, /[\w-]+/)) : undefined;
  }
}
