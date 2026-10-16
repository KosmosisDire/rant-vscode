import * as os from "node:os";
import * as vscode from "vscode";

import type { LogLine, RantNode } from "rant-client";

import type { Bridge } from "../../bridge/connection.ts";
import { requireCli } from "../../cli/current.ts";
import { firstError } from "../../cli/errors.ts";
import { CliMissing, runCli } from "../../cli/exec.ts";
import { EntityPanel } from "./panel.ts";
import type { MeshView } from "./provider.ts";
import type { MeshItem } from "./tree.ts";

/** `rant bridge <verb>` with a progress note, then a fresh connection. */
async function bridgeCommand(bridge: Bridge, verb: "enable" | "start" | "restart", title: string): Promise<void> {
  const cli = requireCli();
  if (!cli) return;
  try {
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () =>
      runCli(cli, ["bridge", verb], os.homedir(), 120000),
    );
    if (r.code !== 0) {
      void vscode.window.showErrorMessage(firstError(r.stderr + r.stdout) ?? `rant bridge ${verb} failed`);
      return;
    }
  } catch (e) {
    if (e instanceof CliMissing) void requireCli();
    else void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    return;
  }
  await bridge.reconnect();
}

/** Asks for the passphrase of the bridge the setting names and keeps it in secret storage. */
async function askPassphrase(bridge: Bridge, url: string): Promise<boolean> {
  const passphrase = await vscode.window.showInputBox({ prompt: `Passphrase of the bridge at ${url}`, password: true, ignoreFocusOut: true });
  if (passphrase === undefined) return false;
  await bridge.setPassphrase(url, passphrase);
  return true;
}

/** Points the Mesh view at a bridge: a URL, or empty for the one on this machine. */
async function chooseBridge(bridge: Bridge): Promise<void> {
  const url = await vscode.window.showInputBox({
    prompt: "The bridge to connect to, such as ws://192.168.1.20:7480 or wss://bridge.example.com. Empty uses the one on this machine.",
    value: bridge.remote,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() === "" || /^wss?:\/\/\S+$/.test(v.trim()) ? undefined : "A ws:// or wss:// URL, or empty"),
  });
  if (url === undefined) return;
  const next = url.trim();
  // the passphrase is stored first, so the reconnect the setting causes already has it
  if (next && !(await askPassphrase(bridge, next))) return;
  if (next === bridge.remote) await bridge.reconnect();
  else await vscode.workspace.getConfiguration("rant").update("bridgeUrl", next || undefined, vscode.ConfigurationTarget.Global);
}

/** The other nodes' log lines in an output channel, from the first time they are asked for. */
class MeshLogs implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel("Rant Mesh Logs");
  private hold: vscode.Disposable | undefined;
  private watch: vscode.Disposable | undefined;
  private node: RantNode | undefined;
  private readonly bridge: Bridge;

  constructor(bridge: Bridge) {
    this.bridge = bridge;
  }

  show(): void {
    this.channel.show(true);
    if (this.hold) return;
    this.hold = this.bridge.want();
    this.watch = this.bridge.onDidChange(() => void this.subscribe());
    void this.subscribe();
  }

  private async subscribe(): Promise<void> {
    const node = this.bridge.state === "open" ? this.bridge.node : undefined;
    if (!node || node === this.node) return;
    this.node = node;
    const line = (l: LogLine) => {
      const at = new Date(l.wallUs / 1000).toISOString().slice(11, 23);
      this.channel.appendLine(`${at} ${l.level.padEnd(5)} ${l.node}: ${l.text}`);
    };
    await node.onLog(line).catch((e: unknown) => this.channel.appendLine(`cannot read the mesh logs: ${e instanceof Error ? e.message : String(e)}`));
  }

  dispose(): void {
    this.hold?.dispose();
    this.watch?.dispose();
    this.channel.dispose();
  }
}

export function registerMeshCommands(bridge: Bridge, view: MeshView, extension: vscode.Uri): vscode.Disposable[] {
  const logs = new MeshLogs(bridge);
  return [
    logs,
    vscode.commands.registerCommand("rant.mesh.refresh", () => view.refresh()),
    vscode.commands.registerCommand("rant.mesh.open", (row?: MeshItem) => {
      if (row?.kind === "entity") EntityPanel.show(bridge, row.entity, extension);
    }),
    vscode.commands.registerCommand("rant.mesh.logs", () => logs.show()),
    vscode.commands.registerCommand("rant.mesh.domain", async () => {
      const text = await vscode.window.showInputBox({
        prompt: "The Rant domain to explore, empty to follow the workspace",
        value: String(bridge.domain),
        validateInput: (v) => (v === "" || (/^\d+$/.test(v) && Number(v) <= 65535) ? undefined : "A number from 0 to 65535"),
      });
      if (text === undefined) return;
      const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration("rant").update("domain", text === "" ? undefined : Number(text), target);
    }),
    vscode.commands.registerCommand("rant.bridge.enable", () => bridgeCommand(bridge, "enable", "Enabling the Rant bridge")),
    vscode.commands.registerCommand("rant.bridge.start", () => bridgeCommand(bridge, "start", "Starting the Rant bridge")),
    vscode.commands.registerCommand("rant.bridge.restart", () => bridgeCommand(bridge, "restart", "Restarting the Rant bridge")),
    vscode.commands.registerCommand("rant.bridge.reconnect", () => bridge.reconnect()),
    vscode.commands.registerCommand("rant.bridge.choose", () => chooseBridge(bridge)),
    vscode.commands.registerCommand("rant.bridge.passphrase", async () => {
      if (!bridge.remote) {
        void vscode.window.showInformationMessage("The bridge on this machine is read from ~/.rant/bridge.yaml. Choose a bridge to use another one.");
        return;
      }
      if (await askPassphrase(bridge, bridge.remote)) await bridge.reconnect();
    }),
  ];
}
