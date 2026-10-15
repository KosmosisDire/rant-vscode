import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import type { MeshEntity, Publisher, RantNode, RemoteFunction, RemoteTask, RemoteVariable, Subscriber, TaskCall } from "rant-client";

import type { Bridge } from "../../bridge/connection.ts";
import { show, template } from "./format.ts";

const FLUSH_MS = 100;

/** What the page sends back. text is the JSON the user typed. */
type FromPage =
  | { type: "ready" }
  | { type: "publish"; text: string }
  | { type: "set"; text: string; force: boolean }
  | { type: "unforce" }
  | { type: "call"; text: string }
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
  private latest: { text: string; info: string } | undefined;
  private lastStatus = "";
  private received = 0;
  private flushed = Date.now();
  private readonly timer: NodeJS.Timeout;
  private readonly bridge: Bridge;
  private readonly entity: MeshEntity;
  private readonly key: string;

  private constructor(bridge: Bridge, entity: MeshEntity, extension: vscode.Uri, key: string) {
    this.bridge = bridge;
    this.entity = entity;
    this.key = key;
    const media = vscode.Uri.joinPath(extension, "media");
    this.panel = vscode.window.createWebviewPanel("rant.entity", entity.name, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.webview.html = this.html(media);
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
        this.h.sub = await node.subscriber(e.name, value, (v, m) => this.value(v, `from node ${m.publisher}`), { maxRateHz: 30 });
      } else if (e.kind === "variable") {
        const v = await node.remoteVariable(e.name, value);
        v.onChange((x, info) => this.value(x, `${info.forced ? "forced, " : ""}${info.source ? `written by node ${info.source}` : "from the owner"}`));
        this.h.variable = v;
      } else if (e.kind === "function") {
        this.h.fn = await node.remoteFunction(e.name, value, e.rsp?.dsl ?? null);
      } else {
        this.h.task = await node.remoteTask(e.name, value, e.prg?.dsl ?? null, e.rsp?.dsl ?? null);
      }
      this.status(e.kind === "topic" || e.kind === "variable" ? "waiting for a value" : "ready");
    } catch (err) {
      this.status(`cannot open ${e.kind} ${e.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private value(v: unknown, info: string): void {
    this.received++;
    this.latest = { text: show(v), info };
  }

  // values can arrive far faster than a page can draw them, so it gets the newest ten times a second
  private flush(): void {
    if (!this.latest) return;
    const now = Date.now();
    const rate = (this.received * 1000) / Math.max(1, now - this.flushed);
    this.post({ type: "value", text: this.latest.text, info: `${this.latest.info}, ${rate.toFixed(rate < 10 ? 1 : 0)} per second` });
    this.latest = undefined;
    this.received = 0;
    this.flushed = now;
  }

  private parse(text: string): { ok: true; value: unknown } | { ok: false } {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      this.status(`not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false };
    }
  }

  private async onPage(m: FromPage): Promise<void> {
    const e = this.entity;
    try {
      switch (m.type) {
        case "ready":
          this.post({
            type: "init",
            kind: e.kind,
            name: e.name,
            schema: [e.schema?.dsl, e.prg?.dsl, e.rsp?.dsl].filter(Boolean).join("\n\n") || "untyped bytes",
            template: show(template(e.schema)),
            typed: !!e.schema,
            writable: e.kind === "topic" || (e.kind === "variable" && e.writable !== false),
            forceable: !!e.forceable,
            cancellable: !!e.cancellable,
          });
          if (this.lastStatus) this.status(this.lastStatus);
          await this.attach();
          return;
        case "publish": {
          const v = this.parse(m.text);
          if (!v.ok || !this.node) return;
          this.h.pub ??= await this.node.publisher(e.name, e.schema?.dsl ?? null, { reliable: e.reliable });
          this.h.pub.send(v.value);
          this.status("published");
          return;
        }
        case "set": {
          const v = this.parse(m.text);
          if (!v.ok || !this.h.variable) return;
          if (m.force) this.h.variable.force(v.value);
          else this.h.variable.set(v.value);
          this.status(m.force ? "forced" : "set");
          return;
        }
        case "unforce":
          this.h.variable?.unforce();
          this.status("released");
          return;
        case "call": {
          const v = this.parse(m.text);
          if (!v.ok) return;
          if (this.h.fn) {
            this.status("calling");
            const r = await this.h.fn.call(v.value);
            this.post({ type: "result", ok: r.ok, head: r.ok ? "ok" : `${r.status}: ${r.message}`, text: r.hasValue ? show(r.value) : "" });
          } else if (this.h.task) {
            const call = this.h.task.call(v.value);
            this.h.call = call;
            this.post({ type: "running", on: true });
            call.onProgress((p) => this.post({ type: "progress", text: p === null ? "running" : show(p) }));
            const r = await call.result;
            if (this.h.call === call) this.h.call = undefined;
            this.post({ type: "running", on: false });
            this.post({ type: "result", ok: r.ok, head: r.ok ? "ok" : `${r.status}: ${r.message}`, text: r.hasValue ? show(r.value) : "" });
          }
          this.status("ready");
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

  private html(media: vscode.Uri): string {
    const web = this.panel.webview;
    const nonce = randomBytes(16).toString("base64");
    const script = web.asWebviewUri(vscode.Uri.joinPath(media, "entity.js"));
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
