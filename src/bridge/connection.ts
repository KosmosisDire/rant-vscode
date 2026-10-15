import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { RantNode } from "rant-client";
import type { RantEvent } from "rant-client";

import { bridgeSettings, meshDomain, rantHome } from "./settings.ts";
import type { BridgeSettings } from "./settings.ts";

/** missing: no local bridge.yaml. down: nothing answers. refused: the bridge said no, a wrong passphrase. */
export type BridgeState = "missing" | "down" | "connecting" | "open" | "reconnecting" | "refused";

const RETRY_MS = 5000;

/**
 * The extension's one node on the mesh, through the bridge `rant.bridgeUrl` names, else the one
 * on this machine. It connects while anything wants it.
 */
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
  /** Moves on every disconnect, so an attempt that finishes after one knows it is stale. */
  private generation = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly output: vscode.LogOutputChannel;
  private readonly secrets: vscode.SecretStorage;

  constructor(output: vscode.LogOutputChannel, secrets: vscode.SecretStorage) {
    this.output = output;
    this.secrets = secrets;
  }

  /** The bridge setting, empty for the bridge on this machine. */
  get remote(): string {
    return vscode.workspace.getConfiguration("rant").get<string>("bridgeUrl", "").trim();
  }

  /** Keeps the passphrase of a bridge elsewhere in the editor's secret storage. */
  setPassphrase(url: string, passphrase: string): Thenable<void> {
    return this.secrets.store(`rant.bridge.${url}`, passphrase);
  }

  /** Where to connect: the setting with its stored passphrase, else what this machine's bridge wrote. */
  private async target(): Promise<BridgeSettings | undefined> {
    const remote = this.remote;
    if (remote) return { url: remote, passphrase: (await this.secrets.get(`rant.bridge.${remote}`)) ?? "" };
    const home = rantHome(process.env, os.homedir());
    const config = await readFile(path.join(home, "bridge.yaml"), "utf8").catch(() => undefined);
    if (config === undefined) {
      this.set("missing", `no ${path.join(home, "bridge.yaml")}, run rant bridge enable`);
      return undefined;
    }
    const state = await readFile(path.join(home, "bridge.state"), "utf8").catch(() => undefined);
    return bridgeSettings(config, state);
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
    const generation = this.generation;
    clearTimeout(this.timer);
    try {
      const s = await this.target();
      if (!s) {
        this.retry();
        return;
      }
      this.url = s.url;
      this.domain = meshDomain(vscode.workspace.getConfiguration("rant").get<number | null>("domain", null), process.env);
      this.set("connecting", `connecting to ${s.url}`);
      const node = await RantNode.connect(s.url, {
        passphrase: s.passphrase,
        // tooling nodes share one name, like the explorer
        name: "vscode",
        domain: this.domain,
        transport: "websocket",
        // an observer learns the names and types of entities it does not use itself, of every peer
        fetchDetails: true,
        maxPeers: 256,
        onEvent: (e) => this.log(e),
      });
      if (this.wanted === 0 || generation !== this.generation) {
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
      if (generation !== this.generation) return;
      const refused = /passphrase|protocol/.test(why);
      this.set(refused ? "refused" : "down", why);
      // asking again with the same passphrase cannot help, a new one reconnects
      if (!refused) this.retry();
    } finally {
      this.connecting = false;
      // a reconnect came while this attempt ran, so it starts over with the new settings
      if (generation !== this.generation) void this.connect();
    }
  }

  private retry(): void {
    clearTimeout(this.timer);
    if (this.wanted > 0) this.timer = setTimeout(() => void this.connect(), RETRY_MS);
  }

  private disconnect(): void {
    this.generation++;
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
