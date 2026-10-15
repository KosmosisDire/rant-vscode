import * as vscode from "vscode";

import type { MeshEntity, Peer } from "rant-client";

import type { Bridge } from "../../bridge/connection.ts";
import type { WorkspacesView } from "../workspaces/provider.ts";
import { buildMesh, builtIn, meshCounts, nest } from "./tree.ts";
import type { MeshItem } from "./tree.ts";

const POLL_MS = 1000;

// what the rows show, so the tree is redrawn only when that changes
const shown = (t: MeshItem[]) => JSON.stringify(t, (k, v: unknown) => (k === "peer" || k === "entity" ? undefined : v));

/** The Mesh view: the nodes by group and the entities as one tree, read again when the mesh moves. */
export class MeshView implements vscode.TreeDataProvider<MeshItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<MeshItem | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private tree: MeshItem[] = [];
  private epoch = -1;
  private peers: Peer[] = [];
  private entities: MeshEntity[] = [];
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private holds: vscode.Disposable[] = [];
  private readonly view: vscode.TreeView<MeshItem>;
  private readonly bridge: Bridge;
  private readonly workspaces: WorkspacesView;
  private readonly icons: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [this.changed];

  constructor(bridge: Bridge, workspaces: WorkspacesView, extension: vscode.Uri) {
    this.bridge = bridge;
    this.workspaces = workspaces;
    this.icons = vscode.Uri.joinPath(extension, "media", "icons");
    this.view = vscode.window.createTreeView("rant.mesh", { treeDataProvider: this });
    this.disposables.push(
      this.view,
      this.view.onDidChangeVisibility((e) => (e.visible ? this.show() : this.hide())),
      bridge.onDidChange(() => {
        this.epoch = -1;
        if (bridge.state !== "open") this.clear();
        void this.poll();
      }),
      // which nodes run under which group comes from the workspaces
      workspaces.onDidChangeTreeData(() => this.rebuild()),
    );
    if (this.view.visible) this.show();
  }

  /** The explorer's icon for a row, in its colors. */
  private icon(name: string): { light: vscode.Uri; dark: vscode.Uri } {
    return { light: vscode.Uri.joinPath(this.icons, `${name}-light.svg`), dark: vscode.Uri.joinPath(this.icons, `${name}-dark.svg`) };
  }

  getTreeItem(n: MeshItem): vscode.TreeItem {
    const open = n.kind === "section" || n.kind === "group";
    const folds = n.kind !== "entity" && !(n.kind === "node" && !n.peer);
    const item = new vscode.TreeItem(
      n.label,
      !folds ? vscode.TreeItemCollapsibleState.None : open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = n.id;
    switch (n.kind) {
      case "section":
        item.iconPath = this.icon(n.id);
        break;
      case "folder":
        // without one VS Code pulls the icons of leaves beside it into the arrow column
        item.iconPath = this.icon("folder");
        break;
      case "group":
        item.iconPath = new vscode.ThemeIcon("layers");
        item.contextValue = "group.running";
        break;
      case "node":
        item.iconPath = this.icon(n.state === "up" ? "node-up" : "node-joining");
        // only a node a workspace started can be stopped or restarted from here
        item.contextValue = n.root ? "node.running" : "peer";
        break;
      case "entity":
        item.iconPath = this.icon(n.entity.kind);
        item.contextValue = `entity.${n.entity.kind}`;
        item.command = { command: "rant.mesh.open", title: "Open", arguments: [n] };
        break;
    }
    if (n.kind !== "section" && n.kind !== "folder") {
      item.description = n.description;
      item.tooltip = n.tooltip;
    }
    return item;
  }

  async getChildren(n?: MeshItem): Promise<MeshItem[]> {
    if (!n) return this.tree;
    if (n.kind === "section" || n.kind === "folder" || n.kind === "group") return n.children;
    if (n.kind !== "node" || !n.peer || !this.bridge.node) return [];
    // a node's own entities are read when it is opened
    const list = await this.bridge.node.reflection.entities(n.peer.id).catch(() => []);
    return nest(meshCounts(list.filter((e) => e.provides && !builtIn(e.name)), this.entities), n.id);
  }

  /** Reads the whole mesh again. */
  async refresh(): Promise<void> {
    this.epoch = -1;
    await this.poll();
  }

  private show(): void {
    if (!this.holds.length) this.holds = [this.bridge.want(), this.workspaces.watch()];
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  private hide(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const h of this.holds) h.dispose();
    this.holds = [];
  }

  private clear(): void {
    this.peers = [];
    this.entities = [];
    if (this.tree.length) {
      this.tree = [];
      this.changed.fire();
    }
  }

  private rebuild(): void {
    if (this.bridge.state !== "open") return;
    const tree = buildMesh(this.peers, this.entities, this.workspaces.started());
    if (shown(tree) === shown(this.tree) && this.tree.length) return;
    this.tree = tree;
    this.changed.fire();
  }

  private async poll(): Promise<void> {
    const node = this.bridge.node;
    if (this.polling || !node || this.bridge.state !== "open") return;
    this.polling = true;
    try {
      const r = node.reflection;
      const [epoch, peers] = await Promise.all([r.epoch(), r.peers()]);
      if (epoch !== this.epoch) this.entities = await r.mesh();
      this.epoch = epoch;
      this.peers = peers;
      this.rebuild();
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
