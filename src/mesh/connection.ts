import * as vscode from "vscode";

import { openNode } from "rant-middleware";
import type { RantEvent, RantNode } from "rant-middleware";
import { TunnelNet } from "rant-middleware/tunnel";
import type { TunnelEvent } from "rant-middleware/tunnel";
import { UdpNet } from "rant-middleware/udp";

import { meshDomain } from "./settings.ts";

/** down: not joined, retrying. refused: the bridge said no, a wrong passphrase. */
export type MeshState = "down" | "connecting" | "open" | "reconnecting" | "refused";

const RETRY_MS = 5000;

/**
 * The extension's one node on the mesh: on this machine's network, or through the bridge that
 * `rant.bridgeUrl` names. It is open while anything wants it.
 */
export class MeshConnection implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  node: RantNode | undefined;
  state: MeshState = "down";
  /** Why the state is what it is, as one line. */
  detail = "";
  domain = 0;
  private net: UdpNet | TunnelNet | undefined;
  private wanted = 0;
  private connecting = false;
  /** Moves on every disconnect, so an attempt that finishes after one knows it is stale. */
  private generation = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly output: vscode.LogOutputChannel;
  private readonly secrets: vscode.SecretStorage;
  private readonly workspaceDomain: () => number | undefined;

  constructor(output: vscode.LogOutputChannel, secrets: vscode.SecretStorage, workspaceDomain: () => number | undefined) {
    this.output = output;
    this.secrets = secrets;
    this.workspaceDomain = workspaceDomain;
  }

  private wantedDomain(): number {
    return meshDomain(vscode.workspace.getConfiguration("rant").get<number | null>("domain", null), this.workspaceDomain(), process.env);
  }

  /** Moves to the domain the settings and the workspace now name, when that is another one. */
  async followDomain(): Promise<void> {
    if (this.wanted > 0 && this.wantedDomain() !== this.domain) await this.reconnect();
  }

  /** The bridge setting, empty for this machine's own network. */
  get remote(): string {
    return vscode.workspace.getConfiguration("rant").get<string>("bridgeUrl", "").trim();
  }

  /** Keeps the passphrase of a bridge in the editor's secret storage. */
  setPassphrase(url: string, passphrase: string): Thenable<void> {
    return this.secrets.store(`rant.bridge.${url}`, passphrase);
  }

  /** Keeps the node open until the returned disposable is disposed. */
  want(): vscode.Disposable {
    this.wanted++;
    void this.connect();
    return new vscode.Disposable(() => {
      this.wanted--;
      if (this.wanted === 0) this.disconnect();
    });
  }

  /** Closes the node and opens it again, after a change to the settings. */
  async reconnect(): Promise<void> {
    this.disconnect();
    if (this.wanted > 0) await this.connect();
  }

  private set(state: MeshState, detail: string): void {
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
    const remote = this.remote;
    let net: UdpNet | TunnelNet | undefined;
    try {
      this.domain = this.wantedDomain();
      const where = remote ? `the bridge at ${remote}` : "this machine's network";
      this.set("connecting", `joining ${where}`);
      if (remote) {
        const tunnel = await TunnelNet.connect(remote, {
          passphrase: (await this.secrets.get(`rant.bridge.${remote}`)) ?? "",
          name: "vscode",
          onEvent: (e) => this.logTunnel(e),
        });
        net = tunnel;
        tunnel.onConnectionChange((c) => {
          if (this.net !== tunnel) return;
          if (c.state === "closed") {
            this.drop();
            this.set("down", "the bridge went away");
            this.retry();
          } else if (c.state === "open") this.set("open", `${where}, domain ${this.domain}`);
          else this.set("reconnecting", `reconnecting to ${remote}`);
        });
      } else net = await UdpNet.create();
      // tooling nodes share one name, like the explorer. An observer learns the names and types
      // of entities it does not use itself, of every peer
      const node = await openNode("vscode", { net, domain: this.domain, fetchDetails: true, maxPeers: 256, onEvent: (e) => this.log(e) });
      if (this.wanted === 0 || generation !== this.generation) {
        node.close();
        net.shutdown();
        return;
      }
      this.node = node;
      this.net = net;
      this.set("open", `${where}, domain ${this.domain}`);
    } catch (e) {
      net?.shutdown();
      const why = e instanceof Error ? e.message : String(e);
      if (generation !== this.generation) return;
      const refused = /passphrase|protocol|too old/.test(why);
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

  private drop(): void {
    const node = this.node, net = this.net;
    this.node = undefined;
    this.net = undefined;
    node?.close();
    net?.shutdown();
  }

  private disconnect(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.drop();
    this.set("down", "disconnected");
  }

  private log(e: RantEvent): void {
    if (e.kind === "error") this.output.error(e.text);
    else if (e.kind === "msg_lost") this.output.warn(e.text);
    else this.output.info(e.text);
  }

  private logTunnel(e: TunnelEvent): void {
    if (e.kind === "error") this.output.error(e.text);
    else this.output.info(e.text);
  }

  dispose(): void {
    this.wanted = 0;
    this.disconnect();
    this.changed.dispose();
  }
}
