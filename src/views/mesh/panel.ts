import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import type { Entity, Publisher, RantNode, RemoteFunction, RemoteTask, RemoteVariable, Subscriber, TaskCall } from "rant-middleware";

import type { MeshConnection } from "../../mesh/connection.ts";
import { pack, unpack } from "./pack.ts";
import { blockOf, hasMedia } from "./table.ts";
import type { SchemaBlock } from "./table.ts";

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
  call?: TaskCall<unknown>;
}

/** What a page keeps of an entity: plain data, since the node it was read from may close. */
interface Shown {
  kind: Entity["kind"];
  name: string;
  reliable: boolean;
  writable: boolean;
  forceable: boolean;
  cancellable: boolean;
  from: string;
  schema: SchemaBlock | null;
  prg: SchemaBlock | null;
  rsp: SchemaBlock | null;
}

function shown(e: Entity): Shown {
  return {
    kind: e.kind, name: e.name, reliable: e.reliable, writable: e.writable, forceable: e.forceable, cancellable: e.cancellable, from: e.from,
    schema: e.schema && blockOf(e.schema), prg: e.progressSchema && blockOf(e.progressSchema), rsp: e.rspSchema && blockOf(e.rspSchema),
  };
}

/** A page for one mesh entity: watch a topic or variable, publish, set, call a function or run a task. */
export class EntityPanel implements vscode.Disposable {
  private static readonly open = new Map<string, EntityPanel>();

  static show(mesh: MeshConnection, entity: Entity, extension: vscode.Uri): void {
    const key = `${entity.kind}/${entity.name}`;
    const found = EntityPanel.open.get(key);
    if (found) {
      found.panel.reveal();
      return;
    }
    EntityPanel.open.set(key, new EntityPanel(mesh, shown(entity), extension, key));
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
  private readonly mesh: MeshConnection;
  private readonly entity: Shown;
  private readonly key: string;
  /** A value with a picture in it goes to the page whole, every one: a video frame needs the ones before it. */
  private readonly video: boolean;

  private constructor(mesh: MeshConnection, entity: Shown, extension: vscode.Uri, key: string) {
    this.mesh = mesh;
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
      mesh.want(),
      mesh.onDidChange(() => this.attach()),
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

  /** Makes the handles on the connection's current node, again whenever that node changes. */
  private attach(): void {
    const node = this.mesh.state === "open" ? this.mesh.node : undefined;
    if (node === this.node) return;
    const old = this.h;
    this.h = {};
    this.node = node;
    for (const handle of [old.sub, old.pub, old.variable, old.fn, old.task]) handle?.close();
    if (!node) {
      this.status(`not connected: ${this.mesh.detail}`);
      return;
    }
    const e = this.entity;
    const value = e.schema?.dsl ?? null;
    try {
      if (e.kind === "topic") {
        // best effort never stalls the publisher, and video keeps every frame, so only other values are capped
        this.h.sub = node.subscriber(e.name, value, (v, m) => this.value(v, m.publisherId), this.video ? {} : { maxRateHz: 30 });
      } else if (e.kind === "variable") {
        const v = node.remoteVariable(e.name, value);
        v.onChange((x, update) => this.value(x, update.source));
        this.h.variable = v;
      } else if (e.kind === "function") {
        this.h.fn = node.remoteFunction(e.name, value, e.rsp?.dsl ?? null);
      } else {
        this.h.task = node.remoteTask(e.name, value, e.prg?.dsl ?? null, e.rsp?.dsl ?? null);
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
    if (this.node && !this.node.closed && now - this.namesAt > 1000) {
      this.namesAt = now;
      for (const p of this.node.reflection.peers()) this.names.set(p.id, p.name);
      const found = this.names.get(id);
      if (found) return found;
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

  /** A send's outcome, as the status line words it. */
  private done(what: string, status: string): void {
    this.status(status === "ok" ? what : `not ${what}: ${status.replace(/_/g, " ")}`);
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
          this.attach();
          return;
        case "publish":
          if (!this.node) return;
          this.h.pub ??= this.node.publisher(e.name, e.schema?.dsl ?? null, { reliable: e.reliable });
          this.done("sent", this.h.pub.send(unpack(m.value)));
          return;
        case "set":
          if (!this.h.variable) return;
          this.done(m.force ? "forced" : "set", m.force ? this.h.variable.force(unpack(m.value)) : this.h.variable.set(unpack(m.value)));
          return;
        case "unforce":
          if (this.h.variable) this.done("released", this.h.variable.unforce());
          return;
        case "call": {
          const value = unpack(m.value);
          if (this.h.fn) {
            this.status("calling");
            this.result(await this.h.fn.call(value));
          } else if (this.h.task) {
            const call = this.h.task.call(value, { onProgress: (p) => this.post({ type: "progress", value: p === null ? null : pack(p) }) });
            this.h.call = call;
            this.post({ type: "running", on: true });
            const r = await call.result;
            if (this.h.call === call) this.h.call = undefined;
            this.post({ type: "running", on: false });
            this.result(r);
          }
          this.status("");
          return;
        }
        case "cancel":
          if (this.h.call) this.status(`cancel: ${this.h.call.cancel()}`);
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
    for (const handle of [this.h.sub, this.h.pub, this.h.variable, this.h.fn, this.h.task]) handle?.close();
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }

  /** Closes every entity page, when the extension stops. */
  static disposeAll(): void {
    for (const p of [...EntityPanel.open.values()]) p.dispose();
  }
}
