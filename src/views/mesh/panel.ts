import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import type { MeshEntity, Publisher, RantNode, RemoteFunction, RemoteTask, RemoteVariable, Subscriber, TaskCall } from "rant-client";

import type { Bridge } from "../../bridge/connection.ts";
import { pack, unpack } from "./pack.ts";
import { hasMedia } from "./table.ts";

const FLUSH_MS = 100;

/** What the page sends back. value is packed. */
type FromPage =
  | { type: "ready" }
  | { type: "publish"; value: unknown }
  | { type: "set"; value: unknown; force: boolean }
  | { type: "unforce" }
  | { type: "call"; value: unknown }
  | { type: "cancel" };

interface Handles {
  sub?: Subscriber<unknown>;
  pub?: Publisher<unknown>;
  variable?: RemoteVariable<unknown>;
  fn?: RemoteFunction<unknown, unknown>;
  task?: RemoteTask<unknown, unknown, unknown>;
  call?: TaskCall<unknown, unknown>;
}

/** A page for one mesh entity: watch a topic or variable, publish, set, call a function or run a task. */
export class EntityPanel implements vscode.Disposable {
  private static readonly open = new Map<string, EntityPanel>();

  static show(bridge: Bridge, entity: MeshEntity, extension: vscode.Uri): void {
    const key = `${entity.kind}/${entity.name}`;
    const found = EntityPanel.open.get(key);
    if (found) {
      found.panel.reveal();
      return;
    }
    EntityPanel.open.set(key, new EntityPanel(bridge, entity, extension, key));
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private node: RantNode | undefined;
  private h: Handles = {};
  private latest: unknown;
  private fresh = false;
  private lastStatus = "";
  /** What the head shows, as `rant sub` does: who sends, how fast, how many. */
  private seen = 0;
  private times: number[] = [];
  private from = "";
  private lastAt = 0;
  private statsAt = 0;
  private readonly names = new Map<number, string>();
  private namesAt = 0;
  private readonly timer: NodeJS.Timeout;
  private readonly bridge: Bridge;
  private readonly entity: MeshEntity;
  private readonly key: string;
  /** A value with a picture in it goes to the page whole, every one: a video frame needs the ones before it. */
  private readonly video: boolean;

  private constructor(bridge: Bridge, entity: MeshEntity, extension: vscode.Uri, key: string) {
    this.bridge = bridge;
    this.entity = entity;
    this.key = key;
    this.video = (entity.kind === "topic" || entity.kind === "variable") && hasMedia(entity.schema);
    const media = vscode.Uri.joinPath(extension, "media");
    const dist = vscode.Uri.joinPath(extension, "dist");
    this.panel = vscode.window.createWebviewPanel("rant.entity", entity.name, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media, dist],
    });
    const icons = vscode.Uri.joinPath(media, "icons");
    this.panel.iconPath = { light: vscode.Uri.joinPath(icons, `${entity.kind}-light.svg`), dark: vscode.Uri.joinPath(icons, `${entity.kind}-dark.svg`) };
    this.panel.webview.html = this.html(media, dist);
    this.disposables.push(
      bridge.want(),
      bridge.onDidChange(() => void this.attach()),
      this.panel.webview.onDidReceiveMessage((m: FromPage) => void this.onPage(m)),
      this.panel.onDidDispose(() => this.dispose()),
    );
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
  }

  private post(m: Record<string, unknown>): void {
    void this.panel.webview.postMessage(m);
  }

  private status(text: string): void {
    this.lastStatus = text;
    this.post({ type: "status", text });
  }

  /** Makes the handles on the bridge's current node, again whenever that node changes. */
  private async attach(): Promise<void> {
    const node = this.bridge.state === "open" ? this.bridge.node : undefined;
    if (node === this.node) return;
    const old = this.h;
    this.h = {};
    this.node = node;
    for (const handle of [old.sub, old.pub, old.variable, old.fn, old.task]) void handle?.close().catch(() => {});
    if (!node) {
      this.status(`not connected: ${this.bridge.detail}`);
      return;
    }
    const e = this.entity;
    const value = e.schema?.dsl ?? null;
    try {
      if (e.kind === "topic") {
        // best effort never stalls the publisher, and video keeps every frame, so only other values are capped
        this.h.sub = await node.subscriber(e.name, value, (v, m) => this.value(v, m.publisher), this.video ? {} : { maxRateHz: 30 });
      } else if (e.kind === "variable") {
        const v = await node.remoteVariable(e.name, value);
        v.onChange((x, info) => this.value(x, info.source));
        this.h.variable = v;
      } else if (e.kind === "function") {
        this.h.fn = await node.remoteFunction(e.name, value, e.rsp?.dsl ?? null);
      } else {
        this.h.task = await node.remoteTask(e.name, value, e.prg?.dsl ?? null, e.rsp?.dsl ?? null);
      }
      this.status(e.kind === "topic" || e.kind === "variable" ? "waiting for a value" : "");
    } catch (err) {
      this.status(`cannot open ${e.kind} ${e.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private value(v: unknown, source: number): void {
    const now = Date.now();
    this.seen++;
    this.times.push(now);
    this.lastAt = now;
    this.from = this.nameOf(source);
    if (this.lastStatus) this.status("");
    if (this.video) this.post({ type: "value", value: pack(v) });
    else {
      this.latest = v;
      this.fresh = true;
    }
  }

  /** A node's name from its peer id, 0 being the owner of a variable. Unknown ids read the peers again. */
  private nameOf(id: number): string {
    const known = this.names.get(id);
    if (known) return known;
    if (id === 0 && this.entity.from) return this.entity.from;
    const now = Date.now();
    if (this.node && now - this.namesAt > 1000) {
      this.namesAt = now;
      void this.node.reflection.peers().then((peers) => peers.forEach((p) => this.names.set(p.id, p.name)), () => {});
    }
    return id ? `node ${id}` : "the owner";
  }

  // other values come faster than a page can draw them, so it gets the newest ten times a second
  private flush(): void {
    const now = Date.now();
    if (this.fresh) {
      this.post({ type: "value", value: pack(this.latest) });
      this.fresh = false;
    }
    if (now - this.statsAt < 250 || !this.seen) return;
    this.statsAt = now;
    // messages a second over the last two seconds, across the span they cover, as rant sub
    this.times = this.times.filter((t) => now - t <= 2000);
    const span = this.times.length > 1 ? (this.times[this.times.length - 1]! - this.times[0]!) / 1000 : 0;
    this.post({ type: "stats", from: this.from, hz: span > 0 ? (this.times.length - 1) / span : 0, seen: this.seen, age: (now - this.lastAt) / 1000 });
  }

  private result(r: { ok: boolean; status: string; message: string; hasValue: boolean; value: unknown }): void {
    this.post({ type: "result", ok: r.ok, head: r.ok ? "ok" : `${r.status}: ${r.message}`, value: r.hasValue ? pack(r.value) : undefined });
  }

  private async onPage(m: FromPage): Promise<void> {
    const e = this.entity;
    const calls = e.kind === "function" || e.kind === "task";
    try {
      switch (m.type) {
        case "ready":
          this.post({
            type: "init",
            kind: e.kind,
            name: e.name,
            value: calls ? null : (e.schema ?? null),
            req: calls ? (e.schema ?? null) : null,
            prg: e.prg ?? null,
            rsp: e.rsp ?? null,
            writable: e.kind === "variable" && e.writable !== false,
            forceable: !!e.forceable,
            cancellable: !!e.cancellable,
          });
          if (this.lastStatus) this.status(this.lastStatus);
          await this.attach();
          return;
        case "publish":
          if (!this.node) return;
          this.h.pub ??= await this.node.publisher(e.name, e.schema?.dsl ?? null, { reliable: e.reliable });
          this.h.pub.send(unpack(m.value));
          this.status("sent");
          return;
        case "set":
          if (!this.h.variable) return;
          if (m.force) this.h.variable.force(unpack(m.value));
          else this.h.variable.set(unpack(m.value));
          this.status(m.force ? "forced" : "set");
          return;
        case "unforce":
          this.h.variable?.unforce();
          this.status("released");
          return;
        case "call": {
          const value = unpack(m.value);
          if (this.h.fn) {
            this.status("calling");
            this.result(await this.h.fn.call(value));
          } else if (this.h.task) {
            const call = this.h.task.call(value);
            this.h.call = call;
            this.post({ type: "running", on: true });
            call.onProgress((p) => this.post({ type: "progress", value: p === null ? null : pack(p) }));
            const r = await call.result;
            if (this.h.call === call) this.h.call = undefined;
            this.post({ type: "running", on: false });
            this.result(r);
          }
          this.status("");
          return;
        }
        case "cancel":
          if (this.h.call) this.status(`cancel: ${await this.h.call.cancel()}`);
          return;
      }
    } catch (err) {
      this.status(err instanceof Error ? err.message : String(err));
    }
  }

  private html(media: vscode.Uri, dist: vscode.Uri): string {
    const web = this.panel.webview;
    const nonce = randomBytes(16).toString("base64");
    const script = web.asWebviewUri(vscode.Uri.joinPath(dist, "page.js"));
    const style = web.asWebviewUri(vscode.Uri.joinPath(media, "entity.css"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>${this.entity.name.replace(/[<&"]/g, "")}</title>
</head>
<body>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (EntityPanel.open.get(this.key) !== this) return;
    EntityPanel.open.delete(this.key);
    clearInterval(this.timer);
    for (const handle of [this.h.sub, this.h.pub, this.h.variable, this.h.fn, this.h.task]) void handle?.close().catch(() => {});
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }

  /** Closes every entity page, when the extension stops. */
  static disposeAll(): void {
    for (const p of [...EntityPanel.open.values()]) p.dispose();
  }
}
