import * as vscode from "vscode";

import type { LogLine, RantNode } from "rant-middleware";
import { findBridges } from "rant-middleware/tunnel";
import type { FoundBridge } from "rant-middleware/tunnel";

import type { MeshConnection } from "../../mesh/connection.ts";
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

/** The other nodes' log lines in an output channel, from the first time they are asked for. */
class MeshLogs implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel("Rant Mesh Logs");
  private hold: vscode.Disposable | undefined;
  private watch: vscode.Disposable | undefined;
  private node: RantNode | undefined;
  private readonly mesh: MeshConnection;

  constructor(mesh: MeshConnection) {
    this.mesh = mesh;
  }

  show(): void {
    this.channel.show(true);
    if (this.hold) return;
    this.hold = this.mesh.want();
    this.watch = this.mesh.onDidChange(() => this.subscribe());
    this.subscribe();
  }

  private subscribe(): void {
    const node = this.mesh.state === "open" ? this.mesh.node : undefined;
    if (!node || node === this.node) return;
    this.node = node;
    const line = (l: LogLine) => {
      const at = new Date(l.wallUs / 1000).toISOString().slice(11, 23);
      this.channel.appendLine(`${at} ${l.level.padEnd(5)} ${l.node}: ${l.text}`);
    };
    try {
      node.onLog(line);
    } catch (e) {
      this.channel.appendLine(`cannot read the mesh logs: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  dispose(): void {
    this.hold?.dispose();
    this.watch?.dispose();
    this.channel.dispose();
  }
}

export function registerMeshCommands(mesh: MeshConnection, view: MeshView, extension: vscode.Uri): vscode.Disposable[] {
  const logs = new MeshLogs(mesh);
  return [
    logs,
    vscode.commands.registerCommand("rant.mesh.refresh", () => view.refresh()),
    vscode.commands.registerCommand("rant.mesh.open", (row?: MeshItem) => {
      if (row?.kind === "entity") EntityPanel.show(mesh, row.entity, extension);
    }),
    vscode.commands.registerCommand("rant.mesh.logs", () => logs.show()),
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
