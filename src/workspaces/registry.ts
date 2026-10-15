import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

import { discoverWorkspaces, inSkippedDir, WORKSPACE_FILE } from "./discover.ts";
import { pathKey, rootOf } from "./paths.ts";

export function debounce(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/** The Rant workspaces under the open folders, and the changes to their files. */
export class Registry implements vscode.Disposable {
  roots: string[] = [];
  private readonly rootsChanged = new vscode.EventEmitter<string[]>();
  private readonly configChanged = new vscode.EventEmitter<string>();
  private readonly stateChanged = new vscode.EventEmitter<string>();
  private readonly disposables: vscode.Disposable[] = [this.rootsChanged, this.configChanged, this.stateChanged];
  readonly onDidChangeRoots = this.rootsChanged.event;
  /** A *.rant or *.run file of this workspace root changed. */
  readonly onDidChangeConfig = this.configChanged.event;
  /** The .rant/state file of this workspace root changed. */
  readonly onDidChangeState = this.stateChanged.event;

  private readonly rediscoverSoon = debounce(() => void this.rediscover(), 300);
  private readonly configPending = new Set<string>();
  private readonly stateText = new Map<string, string>();
  private readonly flushConfig = debounce(() => {
    for (const root of this.configPending) this.configChanged.fire(root);
    this.configPending.clear();
  }, 300);

  constructor() {
    const watch = (glob: string, onEvent: (uri: vscode.Uri, kind: "create" | "change" | "delete") => void) => {
      const w = vscode.workspace.createFileSystemWatcher(glob);
      w.onDidCreate((u) => onEvent(u, "create"));
      w.onDidChange((u) => onEvent(u, "change"));
      w.onDidDelete((u) => onEvent(u, "delete"));
      this.disposables.push(w);
    };
    const config = (uri: vscode.Uri, kind: "create" | "change" | "delete") => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder && inSkippedDir(path.relative(folder.uri.fsPath, uri.fsPath))) return;
      if (path.basename(uri.fsPath) === WORKSPACE_FILE && kind !== "change") this.rediscoverSoon();
      const root = rootOf(this.roots, uri.fsPath);
      if (root) {
        this.configPending.add(root);
        this.flushConfig();
      }
    };
    watch("**/*.rant", config);
    watch("**/*.run", config);
    // build files make packages and name their Rant
    watch("**/{CMakeLists.txt,pyproject.toml,*.csproj}", config);
    // every rant read rewrites .rant/state, so only a change of its content counts
    watch("**/.rant/state", (uri) => {
      const root = rootOf(this.roots, path.dirname(path.dirname(uri.fsPath)));
      if (root) void this.checkState(root, uri.fsPath);
    });
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.rediscoverSoon()));
  }

  private async checkState(root: string, file: string): Promise<void> {
    const text = await readFile(file, "utf8").catch(() => "");
    const key = pathKey(root);
    if (this.stateText.get(key) === text) return;
    this.stateText.set(key, text);
    this.stateChanged.fire(root);
  }

  rootOf(file: string): string | undefined {
    return rootOf(this.roots, file);
  }

  /** Looks for workspaces again. Fires onDidChangeRoots and returns true when the set changed. */
  async rediscover(): Promise<boolean> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
    const roots = await discoverWorkspaces(folders);
    const same = roots.length === this.roots.length && roots.every((r, i) => pathKey(r) === pathKey(this.roots[i] ?? ""));
    this.roots = roots;
    if (!same) this.rootsChanged.fire(roots);
    return !same;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
