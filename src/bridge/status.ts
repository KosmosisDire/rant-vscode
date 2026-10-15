import * as vscode from "vscode";

import type { Bridge } from "./connection.ts";

const TEXT: Record<Bridge["state"], string> = {
  missing: "$(debug-disconnect) Rant",
  down: "$(debug-disconnect) Rant",
  connecting: "$(sync~spin) Rant",
  reconnecting: "$(sync~spin) Rant",
  refused: "$(error) Rant",
  open: "$(radio-tower) Rant",
};

/** The bridge's state in the status bar, and the context key the views' welcome text reads. */
export class BridgeStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("rant.bridge", vscode.StatusBarAlignment.Left, 0);
  private readonly sub: vscode.Disposable;
  private readonly bridge: Bridge;

  constructor(bridge: Bridge) {
    this.bridge = bridge;
    this.item.name = "Rant Bridge";
    this.item.command = "rant.mesh.focus";
    this.sub = bridge.onDidChange(() => this.update());
    this.update();
  }

  private update(): void {
    const b = this.bridge;
    void vscode.commands.executeCommand("setContext", "rant.bridge", b.state);
    void vscode.commands.executeCommand("setContext", "rant.bridgeRemote", !!b.remote);
    const domain = b.state === "open" ? ` ${b.domain}` : "";
    this.item.text = TEXT[b.state] + domain;
    this.item.tooltip = `Rant bridge: ${b.state}${b.detail ? `\n${b.detail}` : ""}`;
    this.item.backgroundColor = b.state === "refused" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
    this.item.show();
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}
