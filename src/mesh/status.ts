import * as vscode from "vscode";

import type { MeshConnection } from "./connection.ts";

const TEXT: Record<MeshConnection["state"], string> = {
  down: "$(debug-disconnect) Rant",
  connecting: "$(sync~spin) Rant",
  reconnecting: "$(sync~spin) Rant",
  refused: "$(error) Rant",
  open: "$(radio-tower) Rant",
};

/** The mesh connection in the status bar, and the context keys the views' welcome text reads. */
export class MeshStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("rant.mesh", vscode.StatusBarAlignment.Left, 0);
  private readonly sub: vscode.Disposable;
  private readonly mesh: MeshConnection;

  constructor(mesh: MeshConnection) {
    this.mesh = mesh;
    this.item.name = "Rant Mesh";
    this.item.command = "rant.mesh.focus";
    this.sub = mesh.onDidChange(() => this.update());
    this.update();
  }

  private update(): void {
    const m = this.mesh;
    void vscode.commands.executeCommand("setContext", "rant.mesh", m.state);
    void vscode.commands.executeCommand("setContext", "rant.bridgeRemote", !!m.remote);
    const domain = m.state === "open" ? ` ${m.domain}` : "";
    this.item.text = TEXT[m.state] + domain;
    this.item.tooltip = `Rant mesh: ${m.state}${m.detail ? `\n${m.detail}` : ""}`;
    this.item.backgroundColor = m.state === "refused" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
    this.item.show();
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}
