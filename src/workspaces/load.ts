import * as path from "node:path";

import { firstError, parseErrors } from "../cli/errors.ts";
import type { CliError } from "../cli/errors.ts";
import { CliMissing, runCli } from "../cli/exec.ts";
import type { RunResult } from "../cli/exec.ts";
import type { Cli } from "../cli/locate.ts";
import { parseGroups, parseNodes, parsePackages, parseUses } from "../cli/parse.ts";
import type { GroupInfo, LibUse, NodeListing, PackageInfo } from "../cli/parse.ts";

export interface WorkspaceData {
  root: string;
  name: string;
  packages: PackageInfo[];
  groups: GroupInfo[];
  uses: LibUse[];
  listing: NodeListing;
  /** Why the CLI could not read the workspace, as one line. */
  error?: string;
}

const EMPTY: NodeListing = { domain: 0, nodes: [], runningGroups: [] };

/** The stdout of a command that must succeed. */
async function json(cli: Cli, root: string, args: string[]): Promise<string> {
  const r = await runCli(cli, [...args, "--json"], root);
  if (r.code !== 0) throw new Error(firstError(r.stderr + r.stdout) ?? `rant ${args.join(" ")} failed`);
  return r.stdout;
}

export async function loadNodes(cli: Cli, root: string): Promise<NodeListing> {
  // the mesh is the Mesh view's: here only what the workspace declares and started
  return parseNodes(await json(cli, root, ["ls", "nodes", "--no-mesh"]));
}

/** Everything the tree shows. A config error comes back as `error`, a missing CLI is thrown. */
export async function loadWorkspace(cli: Cli, root: string): Promise<WorkspaceData> {
  const data: WorkspaceData = { root, name: path.basename(root), packages: [], groups: [], uses: [], listing: EMPTY };
  try {
    const [packages, groups, uses, listing] = await Promise.all([
      json(cli, root, ["ls", "packages"]),
      json(cli, root, ["ls", "groups"]),
      json(cli, root, ["lib"]),
      loadNodes(cli, root),
    ]);
    data.packages = parsePackages(packages);
    data.groups = parseGroups(groups);
    data.uses = parseUses(uses);
    data.listing = listing;
  } catch (e) {
    if (e instanceof CliMissing) throw e;
    data.error = e instanceof Error ? e.message : String(e);
  }
  return data;
}

function located(r: RunResult): CliError[] {
  return r.code === 0 ? [] : parseErrors(r.stderr + "\n" + r.stdout);
}

/**
 * The config errors of a workspace. Packages and workspace.rant are read by `ls packages`,
 * and a dry run of each group reads its file. The CLI stops at the first error of a read.
 */
export async function checkWorkspace(cli: Cli, root: string): Promise<CliError[]> {
  const packages = await runCli(cli, ["ls", "packages", "--json"], root);
  if (packages.code !== 0) return located(packages);
  const groups = await runCli(cli, ["ls", "groups", "--json"], root);
  if (groups.code !== 0) return located(groups);
  const names = parseGroups(groups.stdout).map((g) => g.name);
  const runs = await Promise.all(names.map((n) => runCli(cli, ["run", n, "--dry-run"], root)));
  const seen = new Set<string>();
  return runs.flatMap(located).filter((e) => {
    const key = `${e.file}:${e.line}:${e.message}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}
