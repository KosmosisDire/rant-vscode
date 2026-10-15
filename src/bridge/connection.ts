import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { RantNode } from "rant-client";
import type { RantEvent } from "rant-client";

import { bridgeSettings, meshDomain, rantHome } from "./settings.ts";

/** missing: no bridge.yaml. down: nothing answers. refused: the bridge said no. */
export type BridgeState = "missing" | "down" | "connecting" | "open" | "reconnecting" | "refused";

const RETRY_MS = 5000;

/** The extension's one node on the mesh, through the local bridge. It connects while anything wants it. */
export class Bridge implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  node: RantNode | undefined;
  state: BridgeState = "down";
  /** Why the state is what it is, as one line. */
  detail = "";
  url = "";
  domain = 0;
  private wanted = 0;
  private connecting = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly name = `vscode-${randomBytes(3).toString("hex")}`;
  private readonly output: vscode.LogOutputChannel;

  constructor(output: vscode.LogOutputChannel) {
    this.output = output;
  }

  /** Keeps the connection up until the returned disposable is disposed. */
  want(): vscode.Disposable {
    this.wanted++;
    void this.connect();
    return new vscode.Disposable(() => {
      this.wanted--;
      if (this.wanted === 0) this.disconnect();
    });
  }

  /** Drops the connection and connects again, after a change to the settings or the bridge. */
  async reconnect(): Promise<void> {
    this.disconnect();
    if (this.wanted > 0) await this.connect();
  }

  private set(state: BridgeState, detail: string): void {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.changed.fire();
  }

  private async connect(): Promise<void> {
    if (this.node || this.connecting || this.wanted === 0) return;
    this.connecting = true;
    clearTimeout(this.timer);
    try {
      const home = rantHome(process.env, os.homedir());
      const config = await readFile(path.join(home, "bridge.yaml"), "utf8").catch(() => undefined);
      if (config === undefined) {
        this.set("missing", `no ${path.join(home, "bridge.yaml")}, run rant bridge enable`);
        this.retry();
        return;
      }
      const state = await readFile(path.join(home, "bridge.state"), "utf8").catch(() => undefined);
      const s = bridgeSettings(config, state);
      this.url = s.url;
      this.domain = meshDomain(vscode.workspace.getConfiguration("rant").get<number | null>("domain", null), process.env);
      this.set("connecting", `connecting to ${s.url}`);
      const node = await RantNode.connect(s.url, {
        passphrase: s.passphrase,
        name: this.name,
        domain: this.domain,
        transport: "websocket",
        // an observer learns the names and types of entities it does not use itself
        fetchDetails: true,
        onEvent: (e) => this.log(e),
      });
      if (this.wanted === 0) {
        node.close();
        return;
      }
      this.node = node;
      node.onConnectionChange((c) => {
        if (this.node !== node) return;
        if (c.state === "closed") {
          this.node = undefined;
          this.set("down", "the bridge went away");
          this.retry();
        } else this.set(c.state, c.state === "open" ? `${s.url}, domain ${this.domain}` : `reconnecting to ${s.url}`);
      });
      this.set("open", `${s.url}, domain ${this.domain}`);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.set(/passphrase|protocol/.test(why) ? "refused" : "down", why);
      this.retry();
    } finally {
      this.connecting = false;
    }
  }

  private retry(): void {
    clearTimeout(this.timer);
    if (this.wanted > 0) this.timer = setTimeout(() => void this.connect(), RETRY_MS);
  }

  private disconnect(): void {
    clearTimeout(this.timer);
    const node = this.node;
    this.node = undefined;
    node?.close();
    this.set("down", "disconnected");
  }

  private log(e: RantEvent): void {
    if (e.kind === "error" || e.kind === "send_error") this.output.error(e.text);
    else if (e.kind === "warning" || e.kind === "msg_lost" || e.kind === "session_lost") this.output.warn(e.text);
    else this.output.info(e.text);
  }

  dispose(): void {
    this.wanted = 0;
    this.disconnect();
    this.changed.dispose();
  }
}
