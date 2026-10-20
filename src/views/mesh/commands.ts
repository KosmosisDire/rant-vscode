import * as vscode from "vscode";

import { findBridges } from "rant-middleware/tunnel";
import type { FoundBridge } from "rant-middleware/tunnel";

import type { MeshConnection } from "../../mesh/connection.ts";
import { MeshLogFeed, MeshLogs, NodeLog } from "./logs.ts";
import { EntityPanel } from "./panel.ts";
import type { MeshView } from "./provider.ts";
import type { MeshItem } from "./tree.ts";

/** Asks for the passphrase of the bridge the setting names and keeps it in secret storage. */
async function askPassphrase(mesh: MeshConnection, url: string): Promise<boolean> {
  const passphrase = await vscode.window.showInputBox({ prompt: `Passphrase of the bridge at ${url}`, password: true, ignoreFocusOut: true });
  if (passphrase === undefined) return false;
  await mesh.setPassphrase(url, passphrase);
  return true;
}

/** The bridges on this network: any bridge answers rant-bridges.local, else this machine's. */
async function nearbyBridges(): Promise<FoundBridge[]> {
  for (const url of ["ws://rant-bridges.local:6731", "ws://127.0.0.1:6731"]) {
    try {
      const list = await findBridges(url, 2000);
      if (list.length) return list;
    } catch {
      // the next place may answer
    }
  }
  return [];
}

type Choice = vscode.QuickPickItem & { url?: string };

/** Points the Mesh view at a bridge's URL, or empty for this machine's own network. */
async function chooseBridge(mesh: MeshConnection): Promise<void> {
  const pick = vscode.window.createQuickPick<Choice>();
  pick.placeholder = "Where the Mesh view reaches the mesh";
  const fixed: Choice[] = [{ label: "This machine's network", description: "no bridge", url: "" }];
  const other: Choice = { label: "Another bridge...", description: "type its address" };
  pick.items = [...fixed, other];
  pick.busy = true;
  void nearbyBridges().then((list) => {
    pick.items = [...fixed, ...list.map((b): Choice => ({ label: b.name, description: b.url, url: b.url })), other];
    pick.busy = false;
  });
  const chosen = await new Promise<Choice | undefined>((resolve) => {
    pick.onDidAccept(() => resolve(pick.selectedItems[0]));
    pick.onDidHide(() => resolve(undefined));
    pick.show();
  });
  pick.dispose();
  if (!chosen) return;
  const url = chosen !== other ? chosen.url : await vscode.window.showInputBox({
    prompt: "A bridge to reach the mesh through, such as ws://192.168.1.20:6731 or wss://bridge.example.com",
    value: mesh.remote,
    ignoreFocusOut: true,
    validateInput: (v) => (/^wss?:\/\/\S+$/.test(v.trim()) ? undefined : "A ws:// or wss:// URL"),
  });
  if (url === undefined) return;
  const next = url.trim();
  // the passphrase is stored first, so the reconnect the setting causes already has it
  if (next && !(await askPassphrase(mesh, next))) return;
  if (next === mesh.remote) await mesh.reconnect();
  else await vscode.workspace.getConfiguration("rant").update("bridgeUrl", next || undefined, vscode.ConfigurationTarget.Global);
}

export function registerMeshCommands(mesh: MeshConnection, view: MeshView, extension: vscode.Uri): vscode.Disposable[] {
  const feed = new MeshLogFeed(mesh);
  const logs = new MeshLogs(feed);
  const nodeLog = new NodeLog(feed);
  return [
    logs,
    nodeLog,
    feed,
    vscode.commands.registerCommand("rant.mesh.refresh", () => view.refresh()),
    vscode.commands.registerCommand("rant.mesh.open", (row?: MeshItem) => {
      if (row?.kind === "entity") EntityPanel.show(mesh, row.entity, extension);
    }),
    vscode.commands.registerCommand("rant.mesh.logs", () => logs.show()),
    vscode.commands.registerCommand("rant.mesh.nodeLog", (row?: MeshItem) => {
      if (row?.kind === "node") nodeLog.show(row);
    }),
    vscode.commands.registerCommand("rant.mesh.domain", async () => {
      const text = await vscode.window.showInputBox({
        prompt: "The Rant domain to explore, empty to follow the workspace",
        value: String(mesh.domain),
        validateInput: (v) => (v === "" || (/^\d+$/.test(v) && Number(v) <= 65535) ? undefined : "A number from 0 to 65535"),
      });
      if (text === undefined) return;
      const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration("rant").update("domain", text === "" ? undefined : Number(text), target);
    }),
    vscode.commands.registerCommand("rant.mesh.reconnect", () => mesh.reconnect()),
    vscode.commands.registerCommand("rant.bridge.choose", () => chooseBridge(mesh)),
    vscode.commands.registerCommand("rant.bridge.passphrase", async () => {
      if (!mesh.remote) {
        void vscode.window.showInformationMessage("The editor joins this machine's network directly. Choose a bridge to reach a mesh through one.");
        return;
      }
      if (await askPassphrase(mesh, mesh.remote)) await mesh.reconnect();
    }),
  ];
}
