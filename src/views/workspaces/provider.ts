import * as vscode from "vscode";

import { currentCli } from "../../cli/current.ts";
import { CliMissing } from "../../cli/exec.ts";
import { loadNodes, loadWorkspace } from "../../workspaces/load.ts";
import type { WorkspaceData } from "../../workspaces/load.ts";
import { pathKey } from "../../workspaces/paths.ts";
import type { Registry } from "../../workspaces/registry.ts";
import { buildTree, parents } from "./tree.ts";
import type { TreeNode } from "./tree.ts";

const POLL_MS = 3000;

function setContext(key: string, value: boolean): void {
  void vscode.commands.executeCommand("setContext", key, value);
}

function iconOf(n: TreeNode): vscode.ThemeIcon {
  const green = new vscode.ThemeColor("testing.iconPassed");
  switch (n.kind) {
    case "workspace":
      return n.error ? new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground")) : new vscode.ThemeIcon("root-folder");
    case "section":
      return new vscode.ThemeIcon("folder");
    case "package":
      return new vscode.ThemeIcon("package");
    case "group":
      return n.running ? new vscode.ThemeIcon("layers-active", green) : new vscode.ThemeIcon("layers");
    case "include":
      return new vscode.ThemeIcon("layers");
    case "node":
      return n.running ? new vscode.ThemeIcon("circle-filled", green) : new vscode.ThemeIcon("circle-outline");
    case "build":
      // the file icon theme picks the icon from the resource
      return n.open ? vscode.ThemeIcon.File : vscode.ThemeIcon.Folder;
  }
}

function contextOf(n: TreeNode): string {
  if (n.kind === "build" || (n.kind === "package" && n.hasRant !== undefined)) return `${n.kind}.${n.hasRant ? "rant" : "bare"}`;
  // a group's node starts with its group, so an idle one has no start of its own
  if (n.kind === "node" && n.member && !n.running) return "member";
  return n.kind === "workspace" || n.kind === "node" || n.kind === "group"
    ? `${n.kind}.${n.running ? "running" : "idle"}`
    : n.kind;
}

/** The Workspaces view: every Rant workspace with its packages, nodes and groups. */
export class WorkspacesView implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly data = new Map<string, WorkspaceData>();
  private readonly loads = new Map<string, number>();
  private tree: TreeNode[] = [];
  private parentOf = new Map<string, TreeNode | undefined>();
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private watchers = 0;
  readonly view: vscode.TreeView<TreeNode>;
  private readonly disposables: vscode.Disposable[] = [this.changed];

  private readonly registry: Registry;

  constructor(registry: Registry) {
    this.registry = registry;
    this.view = vscode.window.createTreeView("rant.workspaces", { treeDataProvider: this });
    this.disposables.push(
      this.view,
      this.view.onDidChangeVisibility(() => this.pollWhenNeeded()),
      registry.onDidChangeConfig((root) => void this.reload([root])),
      registry.onDidChangeState((root) => void this.reloadNodes(root)),
    );
    this.pollWhenNeeded();
  }

  getTreeItem(n: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      n.label,
      n.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.id = n.id;
    item.description = n.description;
    item.tooltip = n.tooltip;
    item.iconPath = iconOf(n);
    item.contextValue = contextOf(n);
    if (n.kind === "build" && n.path) item.resourceUri = vscode.Uri.file(n.path);
    if (n.open) item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(n.open)] };
    else if (n.kind === "node") item.command = { command: "rant.openSource", title: "Open Source", arguments: [n] };
    else if (n.kind === "include") item.command = { command: "rant.revealGroup", title: "Go to Group", arguments: [n] };
    return item;
  }

  getChildren(n?: TreeNode): TreeNode[] {
    return n ? n.children : this.tree;
  }

  getParent(n: TreeNode): TreeNode | undefined {
    return this.parentOf.get(n.id);
  }

  /** Selects the row of a group by name in a workspace. */
  async revealGroup(root: string, name: string): Promise<void> {
    const id = `${root}|group|${name}`;
    const target = [...this.parentOf.keys()].includes(id) ? this.find(this.tree, id) : undefined;
    if (target) await this.view.reveal(target, { select: true, focus: true, expand: true });
  }

  private find(nodes: TreeNode[], id: string): TreeNode | undefined {
    for (const n of nodes) {
      if (n.id === id) return n;
      const inner = this.find(n.children, id);
      if (inner) return inner;
    }
    return undefined;
  }

  /** What each readable workspace started, for the Mesh view. */
  started(): Pick<WorkspaceData, "root" | "name" | "listing">[] {
    return this.registry.roots.flatMap((r) => {
      const d = this.data.get(pathKey(r));
      return d && !d.error ? [{ root: d.root, name: d.name, listing: d.listing }] : [];
    });
  }

  /** Keeps what runs current while the returned disposable lives, even with this view hidden. */
  watch(): vscode.Disposable {
    this.watchers++;
    this.pollWhenNeeded();
    return new vscode.Disposable(() => {
      this.watchers--;
      this.pollWhenNeeded();
    });
  }

  private pollWhenNeeded(): void {
    if (this.view.visible || this.watchers > 0) {
      if (!this.timer) this.startPolling();
    } else this.stopPolling();
  }

  get roots(): string[] {
    return this.registry.roots;
  }

  /** Reads the given workspaces again with the CLI, all of them when none are named. */
  async reload(roots: string[] = this.registry.roots): Promise<void> {
    for (const key of [...this.data.keys()]) {
      if (!this.registry.roots.some((r) => pathKey(r) === key)) this.data.delete(key);
    }
    const cli = currentCli();
    setContext("rant.cliMissing", !cli);
    setContext("rant.hasWorkspaces", this.registry.roots.length > 0);
    if (!cli) {
      this.data.clear();
      this.rebuild();
      return;
    }
    await Promise.all(
      roots.map(async (root) => {
        const key = pathKey(root);
        const ticket = (this.loads.get(key) ?? 0) + 1;
        this.loads.set(key, ticket);
        try {
          const loaded = await loadWorkspace(cli, root);
          if (this.loads.get(key) === ticket) this.data.set(key, loaded);
        } catch (e) {
          if (!(e instanceof CliMissing)) throw e;
          setContext("rant.cliMissing", true);
        }
      }),
    );
    this.rebuild();
  }

  /** Reads only what runs, the cheap part of a refresh. */
  async reloadNodes(root: string): Promise<void> {
    const cli = currentCli();
    const key = pathKey(root);
    const current = this.data.get(key);
    if (!cli || !current || current.error) return;
    try {
      const listing = await loadNodes(cli, root);
      if (JSON.stringify(listing) === JSON.stringify(current.listing)) return;
      this.data.set(key, { ...current, listing });
      this.rebuild();
    } catch {
      // the next poll or file change tries again
    }
  }

  private rebuild(): void {
    this.tree = buildTree(this.registry.roots.flatMap((r) => this.data.get(pathKey(r)) ?? []));
    this.parentOf = parents(this.tree);
    this.changed.fire();
  }

  private startPolling(): void {
    this.stopPolling();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  private stopPolling(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await Promise.all(this.registry.roots.map((r) => this.reloadNodes(r)));
    } finally {
      this.polling = false;
    }
  }

  dispose(): void {
    this.stopPolling();
    for (const d of this.disposables) d.dispose();
  }
}
