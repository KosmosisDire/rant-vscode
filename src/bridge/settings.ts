import * as path from "node:path";

import { parse } from "yaml";

export interface BridgeSettings {
  url: string;
  passphrase: string;
}

/** Where Rant keeps the bridge config and state: RANT_HOME, else ~/.rant. */
export function rantHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.RANT_HOME || path.join(home, ".rant");
}

function map(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  const v: unknown = parse(text);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * The URL and passphrase from the texts of bridge.yaml and bridge.state. The state's url wins:
 * it is what the running bridge listens on.
 */
export function bridgeSettings(configText: string, stateText?: string): BridgeSettings {
  const config = map(configText);
  const state = map(stateText);
  const port = typeof config.port === "number" ? config.port : 7480;
  const bind = typeof config.bind === "string" && config.bind !== "0.0.0.0" ? config.bind : "127.0.0.1";
  const url = typeof state.url === "string" && state.url ? state.url : `ws://${bind}:${port}`;
  const passphrase = typeof config.passphrase === "string" ? config.passphrase : "";
  return { url, passphrase };
}

/** The mesh domain: the setting when set, else RANT_DOMAIN, else 0. */
export function meshDomain(setting: number | null | undefined, env: NodeJS.ProcessEnv): number {
  if (typeof setting === "number" && Number.isInteger(setting) && setting >= 0 && setting <= 65535) return setting;
  const fromEnv = Number(env.RANT_DOMAIN);
  return env.RANT_DOMAIN && Number.isInteger(fromEnv) && fromEnv >= 0 && fromEnv <= 65535 ? fromEnv : 0;
}
