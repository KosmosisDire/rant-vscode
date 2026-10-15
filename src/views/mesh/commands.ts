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
        prompt: "The Rant domain to explore, empty for RANT_DOMAIN or 0",
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
  ];
}
