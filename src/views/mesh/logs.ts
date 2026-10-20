import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import * as vscode from "vscode";

import type { LogLine, RantNode } from "rant-middleware";

import { requireCli } from "../../cli/current.ts";
import { firstError } from "../../cli/errors.ts";
import type { MeshConnection } from "../../mesh/connection.ts";
import { meshText, outputLine } from "./logText.ts";
import type { NodeItem } from "./tree.ts";

/** How many of each node's mesh lines are kept for a node log opened later. */
const KEPT = 500;
/** How much of a node's process output a node log shows first. */
const OUTPUT_LINES = 200;

/** The other nodes' log lines, read once for every log view, with each node's last lines kept. */
export class MeshLogFeed implements vscode.Disposable {
  private readonly lines = new vscode.EventEmitter<LogLine>();
  private readonly problems = new vscode.EventEmitter<string>();
  readonly onLine = this.lines.event;
  readonly onProblem = this.problems.event;
  private readonly kept = new Map<string, LogLine[]>();
  private hold: vscode.Disposable | undefined;
  private watch: vscode.Disposable | undefined;
  private node: RantNode | undefined;
  private readonly mesh: MeshConnection;

  constructor(mesh: MeshConnection) {
    this.mesh = mesh;
  }

  /** Starts reading, the first time a view asks, so a closed view costs nothing. */
  start(): void {
    if (this.hold) return;
    this.hold = this.mesh.want();
    this.watch = this.mesh.onDidChange(() => this.subscribe());
    this.subscribe();
  }

  /** The kept lines that match, oldest first. */
  recent(match: (l: LogLine) => boolean): LogLine[] {
    return [...this.kept.values()].flat().filter(match).sort((a, b) => a.recvUs - b.recvUs);
  }

  private subscribe(): void {
    const node = this.mesh.state === "open" ? this.mesh.node : undefined;
    if (!node || node === this.node) return;
    this.node = node;
    try {
      node.onLog((l) => {
        const list = this.kept.get(l.node) ?? [];
        list.push(l);
        if (list.length > KEPT) list.shift();
        this.kept.set(l.node, list);
        this.lines.fire(l);
      });
    } catch (e) {
      this.problems.fire(`cannot read the mesh logs: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  dispose(): void {
    this.hold?.dispose();
    this.watch?.dispose();
    this.lines.dispose();
    this.problems.dispose();
  }
}

/** Every other node's log lines in one output channel. */
export class MeshLogs implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel("Rant Mesh Logs", "log");
  private readonly subs: vscode.Disposable[];
  private readonly feed: MeshLogFeed;

  constructor(feed: MeshLogFeed) {
    this.feed = feed;
    this.subs = [
      feed.onLine((l) => this.channel.appendLine(meshText(l, true))),
      feed.onProblem((m) => this.channel.appendLine(m)),
    ];
  }

  show(): void {
    this.channel.show(true);
    this.feed.start();
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.channel.dispose();
  }
}

/** One node's log at a time: its mesh lines, and for a node a workspace here started, what its process wrote. */
export class NodeLog implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel("Rant Node Log", "log");
  private readonly subs: vscode.Disposable[];
  private readonly feed: MeshLogFeed;
  /** a started node is matched by name, so its lines follow it through a restart, any other by its peer */
  private target: { name: string; peerId?: number } | undefined;
  private child: ChildProcess | undefined;

  constructor(feed: MeshLogFeed) {
    this.feed = feed;
    this.subs = [
      feed.onLine((l) => {
        if (this.matches(l)) this.channel.appendLine(meshText(l, false));
      }),
      feed.onProblem((m) => this.channel.appendLine(m)),
    ];
  }

  show(item: NodeItem): void {
    this.stopOutput();
    this.target = { name: item.label, peerId: item.root ? undefined : item.peer?.id };
    this.channel.clear();
    this.channel.appendLine(
      item.root
        ? `${item.label}: its mesh log lines, and its process output marked "output |"`
        : `${item.label}: its mesh log lines. It was not started here, so its process output stays on its machine`,
    );
    this.feed.start();
    for (const l of this.feed.recent((x) => this.matches(x))) this.channel.appendLine(meshText(l, false));
    if (item.root) this.followOutput(item.label, item.root);
    this.channel.show(true);
  }

  private matches(l: LogLine): boolean {
    const t = this.target;
    if (!t) return false;
    return t.peerId !== undefined ? l.nodeId === t.peerId : l.node === t.name;
  }

  /** What the node's process wrote, through the CLI, which follows its log across restarts. */
  private followOutput(name: string, root: string): void {
    const cli = requireCli();
    if (!cli) return;
    const child = spawn(cli.exe, ["log", name, "--follow", "--json", "--lines", String(OUTPUT_LINES)], { cwd: root, windowsHide: true });
    this.child = child;
    let stderr = "";
    readline.createInterface({ input: child.stdout }).on("line", (record) => {
      const line = outputLine(record);
      if (line !== undefined && child === this.child) this.channel.appendLine(`output | ${line}`);
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      if (child === this.child) this.channel.appendLine(`cannot run ${cli.exe}: ${e.message}`);
    });
    child.on("exit", (code) => {
      // a stop of ours ends it too, and says nothing
      if (child !== this.child || code === 0 || code === null) return;
      this.channel.appendLine(`cannot follow its output: ${firstError(stderr) ?? (stderr.trim() || `rant log exited with ${code}`)}`);
    });
  }

  private stopOutput(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }

  dispose(): void {
    this.stopOutput();
    for (const s of this.subs) s.dispose();
    this.channel.dispose();
  }
}
