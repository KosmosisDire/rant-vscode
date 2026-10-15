import * as vscode from "vscode";

import { suggest } from "./context.ts";
import type { Suggestion } from "./context.ts";
import { fileKindOf } from "./vocabulary.ts";

const KINDS: Record<Suggestion["kind"], vscode.CompletionItemKind> = {
  attribute: vscode.CompletionItemKind.Property,
  block: vscode.CompletionItemKind.Struct,
  value: vscode.CompletionItemKind.EnumMember,
  variable: vscode.CompletionItemKind.Variable,
};

export class RantCompletion implements vscode.CompletionItemProvider {
  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] {
    const kind = fileKindOf(doc.fileName);
    if (!kind) return [];
    const word = doc.lineAt(pos.line).text.slice(0, pos.character).match(/[\w.-]*$/)?.[0] ?? "";
    const range = new vscode.Range(pos.line, pos.character - word.length, pos.line, pos.character);
    return suggest(kind, doc.getText(), doc.offsetAt(pos)).map((s) => {
      const item = new vscode.CompletionItem(s.label, KINDS[s.kind]);
      item.documentation = new vscode.MarkdownString(s.doc);
      item.range = range;
      if (s.kind === "attribute" || s.kind === "block") item.insertText = new vscode.SnippetString(s.insert);
      // after `key = ` offer the values the key takes
      if (s.kind === "attribute") item.command = { command: "editor.action.triggerSuggest", title: "" };
      return item;
    });
  }
}
