import * as vscode from "vscode";

import type { MeshEntity, Peer } from "rant-client";

import type { Bridge } from "../../bridge/connection.ts";
import { buildMesh, builtIn, nest } from "./tree.ts";
import type { MeshItem } from "./tree.ts";

const POLL_MS = 1000;

const ICONS: Record<string, string> = { topic: "symbol-event", variable: "symbol-variable", function: "symbol-method", task: "tasklist" };

function iconOf(n: MeshItem): vscode.ThemeIcon {
  switch (n.kind) {
    case "section":
    case "folder":
      return new vscode.ThemeIcon("folder");
    case "peer":
      return n.peer.active
        ? new vscode.ThemeIcon("vm-running", new vscode.ThemeColor(n.peer.missed > 1 ? "list.warningForeground" : "testing.iconPassed"))
        : new vscode.ThemeIcon("vm-outline");
    case "entity":
      return new vscode.ThemeIcon(ICONS[n.entity.kind] ?? "circle-outline");
  }
}

// what the rows show, so the tree is redrawn only when that changes
const shown = (t: MeshItem[]) => JSON.stringify(t, (k, v: unknown) => (k === "peer" || k === "entity" ? undefined : v));

/** The Mesh view: the nodes and entities the bridge's node sees, read again when the mesh moves. */
export class MeshView implements vscode.TreeDataProvider<MeshItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<MeshItem | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private tree: MeshItem[] = [];
  private epoch = -1;
  private peers: Peer[] = [];
  private entities: MeshEntity[] = [];
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private hold: vscode.Disposable | undefined;
  private readonly view: vscode.TreeView<MeshItem>;
  private readonly bridge: Bridge;
  private readonly disposables: vscode.Disposable[] = [this.changed];

  constructor(bridge: Bridge) {
    this.bridge = bridge;
    this.view = vscode.window.createTreeView("rant.mesh", { treeDataProvider: this });
    this.disposables.push(
      this.view,
      this.view.onDidChangeVisibility((e) => (e.visible ? this.show() : this.hide())),
      bridge.onDidChange(() => {
        this.epoch = -1;
        if (bridge.state !== "open") this.clear();
        void this.poll();
      }),
    );
    if (this.view.visible) this.show();
  }

  getTreeItem(n: MeshItem): vscode.TreeItem {
    const folds = n.kind !== "entity";
    const item = new vscode.TreeItem(
      n.label,
      !folds ? vscode.TreeItemCollapsibleState.None
        : n.kind === "section" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = n.id;
    item.iconPath = iconOf(n);
    item.contextValue = n.kind === "entity" ? `entity.${n.entity.kind}` : n.kind;
    if (n.kind !== "section") item.description = n.description;
    if (n.kind === "peer" || n.kind === "entity") item.tooltip = n.tooltip;
    if (n.kind === "entity") item.command = { command: "rant.mesh.open", title: "Open", arguments: [n] };
    return item;
  }

  async getChildren(n?: MeshItem): Promise<MeshItem[]> {
    if (!n) return this.tree;
    if (n.kind === "section" || n.kind === "folder") return n.children;
    if (n.kind !== "peer" || !this.bridge.node) return [];
    // a node's own entities are read when it is opened
    const list = await this.bridge.node.reflection.entities(n.peer.id).catch(() => []);
    return nest(list.filter((e) => e.provides && !builtIn(e.name)), n.id);
  }

  /** Reads the whole mesh again. */
  async refresh(): Promise<void> {
    this.epoch = -1;
    await this.poll();
  }

  private show(): void {
    this.hold ??= this.bridge.want();
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  private hide(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.hold?.dispose();
    this.hold = undefined;
  }

  private clear(): void {
    this.peers = [];
    this.entities = [];
    if (this.tree.length) {
      this.tree = [];
      this.changed.fire();
    }
  }

  private async poll(): Promise<void> {
    const node = this.bridge.node;
    if (this.polling || !node || this.bridge.state !== "open") return;
    this.polling = true;
    try {
      const r = node.reflection;
      const [epoch, peers] = await Promise.all([r.epoch(), r.peers()]);
      let entities = this.entities;
      if (epoch !== this.epoch) entities = await r.mesh();
      this.epoch = epoch;
      const before = shown(buildMesh(this.peers, this.entities));
      this.peers = peers;
      this.entities = entities;
      const tree = buildMesh(peers, entities);
      if (shown(tree) !== before || !this.tree.length) {
        this.tree = tree;
        this.changed.fire();
      }
    } catch {
      // a dropped connection shows through the bridge state, the next poll tries again
    } finally {
      this.polling = false;
    }
  }

  dispose(): void {
    this.hide();
    for (const d of this.disposables) d.dispose();
  }
}
