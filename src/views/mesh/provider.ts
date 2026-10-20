import * as vscode from "vscode";

import type { Condition, Entity, Level, Peer, RantNode } from "rant-middleware";

import type { MeshConnection } from "../../mesh/connection.ts";
import type { WorkspacesView } from "../workspaces/provider.ts";
import { buildMesh, builtIn, conditionItems, meshCounts, nest } from "./tree.ts";
import type { MeshItem } from "./tree.ts";

const POLL_MS = 1000;

// what the rows show, so the tree is redrawn only when that changes
const shown = (t: MeshItem[]) => JSON.stringify(t, (k, v: unknown) => (k === "peer" || k === "entity" ? undefined : v));

// a condition's icon and its colour in the theme, as the Problems view draws them
const levelIcon: Record<Level, vscode.ThemeIcon> = {
  error: new vscode.ThemeIcon("error", new vscode.ThemeColor("problemsErrorIcon.foreground")),
  warn: new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground")),
  info: new vscode.ThemeIcon("info", new vscode.ThemeColor("problemsInfoIcon.foreground")),
  debug: new vscode.ThemeIcon("debug"),
};

/** The Mesh view: the nodes by group and the entities as one tree, read again when the mesh moves. */
export class MeshView implements vscode.TreeDataProvider<MeshItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<MeshItem | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private tree: MeshItem[] = [];
  private epoch = -1;
  private peers: Peer[] = [];
  private entities: Entity[] = [];
  /** each node's latest status set, by peer id */
  private readonly status = new Map<number, Condition[]>();
  private statusNode: RantNode | undefined;
  private timer: NodeJS.Timeout | undefined;
  private holds: vscode.Disposable[] = [];
  private readonly view: vscode.TreeView<MeshItem>;
  private readonly mesh: MeshConnection;
  private readonly workspaces: WorkspacesView;
  private readonly icons: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [this.changed];

  constructor(mesh: MeshConnection, workspaces: WorkspacesView, extension: vscode.Uri) {
    this.mesh = mesh;
    this.workspaces = workspaces;
    this.icons = vscode.Uri.joinPath(extension, "media", "icons");
    this.view = vscode.window.createTreeView("rant.mesh", { treeDataProvider: this });
    this.disposables.push(
      this.view,
      this.view.onDidChangeVisibility((e) => (e.visible ? this.show() : this.hide())),
      mesh.onDidChange(() => {
        this.epoch = -1;
        if (mesh.state !== "open") this.clear();
        this.poll();
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
        // a node with an error or a warning shows it without being opened
        item.iconPath =
          n.worst === "error" || n.worst === "warn" ? levelIcon[n.worst] : this.icon(n.state === "up" ? "node-up" : "node-joining");
        // only a node a workspace started can be stopped or restarted from here
        item.contextValue = n.root ? "node.running" : "peer";
        break;
      case "entity":
        item.iconPath = this.icon(n.entity.kind);
        item.contextValue = `entity.${n.entity.kind}`;
        item.command = { command: "rant.mesh.open", title: "Open", arguments: [n] };
        break;
      case "condition":
        item.iconPath = levelIcon[n.level];
        break;
    }
    if (n.kind !== "section" && n.kind !== "folder") {
      item.description = n.description;
      item.tooltip = n.tooltip;
    }
    return item;
  }

  getChildren(n?: MeshItem): MeshItem[] {
    if (!n) return this.tree;
    if (n.kind === "section" || n.kind === "folder" || n.kind === "group") return n.children;
    const node = this.mesh.node;
    if (n.kind !== "node" || !n.peer || !node || node.closed) return [];
    // a node's own entities are read when it is opened, after its conditions
    const list = node.reflection.entities(n.peer.id);
    return [...conditionItems(n), ...nest(meshCounts(list.filter((e) => e.provides && !builtIn(e.name)), this.entities), n.id)];
  }

  /** Reads the whole mesh again. */
  refresh(): void {
    this.epoch = -1;
    this.poll();
  }

  private show(): void {
    if (!this.holds.length) this.holds = [this.mesh.want(), this.workspaces.watch()];
    clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.poll();
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
    this.status.clear();
    this.statusNode = undefined;
    if (this.tree.length) {
      this.tree = [];
      this.changed.fire();
    }
  }

  private rebuild(): void {
    if (this.mesh.state !== "open") return;
    const tree = buildMesh(this.peers, this.entities, this.workspaces.started(), this.mesh.domain, this.status);
    if (shown(tree) === shown(this.tree) && this.tree.length) return;
    this.tree = tree;
    this.changed.fire();
  }

  /** Every other node's status from when this node opens: each set replaces that node's last. */
  private watchStatus(node: RantNode): void {
    this.statusNode = node;
    this.status.clear();
    node.onStatus((u) => {
      if (u.conditions.length) this.status.set(u.nodeId, u.conditions);
      else this.status.delete(u.nodeId);
      this.rebuild();
    });
  }

  private poll(): void {
    const node = this.mesh.node;
    if (!node || node.closed || this.mesh.state !== "open") return;
    if (node !== this.statusNode) this.watchStatus(node);
    const r = node.reflection;
    const epoch = r.epoch;
    if (epoch !== this.epoch) this.entities = r.mesh();
    this.epoch = epoch;
    this.peers = r.peers();
    this.rebuild();
  }

  dispose(): void {
    this.hide();
    for (const d of this.disposables) d.dispose();
  }
}
