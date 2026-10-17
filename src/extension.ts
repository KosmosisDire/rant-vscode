import * as vscode from "vscode";

import { RantCompletion, TRIGGERS } from "./language/completion.ts";
import { RantDiagnostics } from "./language/diagnostics.ts";
import { LANGUAGE_IDS } from "./language/vocabulary.ts";
import { MeshConnection } from "./mesh/connection.ts";
import { MeshStatus } from "./mesh/status.ts";
import { onCommandDone } from "./terminal.ts";
import { registerMeshCommands } from "./views/mesh/commands.ts";
import { EntityPanel } from "./views/mesh/panel.ts";
import { MeshView } from "./views/mesh/provider.ts";
import { registerCommands } from "./views/workspaces/commands.ts";
import { WorkspacesView } from "./views/workspaces/provider.ts";
import { Registry } from "./workspaces/registry.ts";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const registry = new Registry();
  const view = new WorkspacesView(registry);
  const diagnostics = new RantDiagnostics();
  const connection = new MeshConnection(vscode.window.createOutputChannel("Rant Mesh", { log: true }), context.secrets, () => view.domain());
  const mesh = new MeshView(connection, view, context.extensionUri);
  const refreshAll = async () => {
    // a changed set of workspaces reloads the view through onDidChangeRoots
    if (!(await registry.rediscover())) await view.reload();
    for (const root of registry.roots) diagnostics.schedule(root);
  };

  const checkDocument = (doc: vscode.TextDocument) => {
    const root = LANGUAGE_IDS.includes(doc.languageId) ? registry.rootOf(doc.fileName) : undefined;
    if (root) diagnostics.schedule(root);
  };

  context.subscriptions.push(
    registry,
    view,
    diagnostics,
    ...registerCommands(view, refreshAll),
    // pages close their handles before the connection closes the node
    { dispose: () => EntityPanel.disposeAll() },
    mesh,
    new MeshStatus(connection),
    ...registerMeshCommands(connection, mesh, context.extensionUri),
    connection,
    vscode.languages.registerCompletionItemProvider(LANGUAGE_IDS.map((language) => ({ language })), new RantCompletion((f) => view.dataFor(f)), ...TRIGGERS),
    registry.onDidChangeRoots((roots) => {
      void view.reload();
      roots.forEach((r) => diagnostics.schedule(r));
    }),
    registry.onDidChangeConfig((root) => diagnostics.schedule(root)),
    vscode.workspace.onDidOpenTextDocument(checkDocument),
    vscode.workspace.onDidSaveTextDocument(checkDocument),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("rant.cliPath")) void refreshAll();
      if (e.affectsConfiguration("rant.domain") || e.affectsConfiguration("rant.bridgeUrl")) void connection.reconnect();
    }),
    // a command may add a package, a node or a build file, or move Rant, so all of it is read again
    onCommandDone((root) => void view.reload([root])),
    view.onDidChangeDomain(() => void connection.followDomain()),
  );

  await refreshAll();
  vscode.workspace.textDocuments.forEach(checkDocument);
}

export function deactivate(): void {}
