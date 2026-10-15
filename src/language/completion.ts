import * as vscode from "vscode";

import type { WorkspaceData } from "../workspaces/load.ts";
import { knownFrom, suggest } from "./context.ts";
import type { Suggestion } from "./context.ts";
import { fileKindOf } from "./vocabulary.ts";

const KINDS: Record<Suggestion["kind"], vscode.CompletionItemKind> = {
  attribute: vscode.CompletionItemKind.Property,
  block: vscode.CompletionItemKind.Struct,
  value: vscode.CompletionItemKind.EnumMember,
  variable: vscode.CompletionItemKind.Variable,
};

/** Typing one of these opens the list. A new line counts, so a blank line shows what can go on it. */
export const TRIGGERS = [".", "=", " ", '"', "\n"];

export class RantCompletion implements vscode.CompletionItemProvider {
  private readonly workspaceOf: (file: string) => WorkspaceData | undefined;

  constructor(workspaceOf: (file: string) => WorkspaceData | undefined) {
    this.workspaceOf = workspaceOf;
  }

  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] {
    const kind = fileKindOf(doc.fileName);
    if (!kind) return [];
    const line = doc.lineAt(pos.line).text.slice(0, pos.character);
    // inside a string the whole of it so far is replaced, slashes and all
    const inString = (line.match(/"/g)?.length ?? 0) % 2 === 1;
    const typed = inString ? line.slice(line.lastIndexOf('"') + 1) : (line.match(/[\w.-]*$/)?.[0] ?? "");
    const range = new vscode.Range(pos.line, pos.character - typed.length, pos.line, pos.character);
    const w = this.workspaceOf(doc.fileName);
    const known = w && !w.error ? knownFrom(w, doc.fileName) : undefined;
    return suggest(kind, doc.getText(), doc.offsetAt(pos), known).map((s) => {
      const item = new vscode.CompletionItem(s.label, KINDS[s.kind]);
      item.documentation = new vscode.MarkdownString(s.doc);
      item.range = range;
      if (s.kind === "attribute" || s.kind === "block") item.insertText = new vscode.SnippetString(s.insert);
      // after `key = ` or in a new block's label, offer what goes there
      if (s.more) item.command = { command: "editor.action.triggerSuggest", title: "", arguments: [{ auto: true }] };
      return item;
    });
  }
}
