/** The mesh domain: the setting when set, else the workspace's as the CLI resolves it, else RANT_DOMAIN, else 0. */
export function meshDomain(setting: number | null | undefined, workspace: number | undefined, env: NodeJS.ProcessEnv): number {
  if (typeof setting === "number" && Number.isInteger(setting) && setting >= 0 && setting <= 65535) return setting;
  if (workspace !== undefined) return workspace;
  const fromEnv = Number(env.RANT_DOMAIN);
  return env.RANT_DOMAIN && Number.isInteger(fromEnv) && fromEnv >= 0 && fromEnv <= 65535 ? fromEnv : 0;
}
