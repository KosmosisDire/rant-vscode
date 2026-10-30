import * as path from "node:path";

import type { GroupInfo, LibUse, NodeEntry, PackageInfo } from "../../cli/parse.ts";
import type { WorkspaceData } from "../../workspaces/load.ts";
import { pathKey } from "../../workspaces/paths.ts";

export type NodeKind = "workspace" | "section" | "package" | "node" | "group" | "include" | "build";

/** One row of the Workspaces view, free of the editor so it can be tested. */
export interface TreeNode {
  kind: NodeKind;
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** Something under this row runs. */
  running: boolean;
  /** The workspace folder the row belongs to. */
  root: string;
  /** What the CLI takes for this row: a package or group name, a running node's mesh name, an idle node's type. */
  ref: string;
  /** The type of a node row, whose source `rant info node` finds. */
  nodeType?: string;
  /** A node under the group that starts it, which starts only with its group. */
  member?: boolean;
  /** The folder `rant add` takes for a package or build system, relative to the workspace. */
  lib?: string;
  /** Takes Rant, so it is updated rather than added to. Unset where neither fits. */
  hasRant?: boolean;
  /** The folder of a package, the file of a group, the build file or venv of a build system. */
  path?: string;
  /** The file a click opens. */
  open?: string;
  /** A package rant installed, which is never built or added to. */
  installed?: boolean;
  /** The workspace could not be read. */
  error: boolean;
  children: TreeNode[];
}

function row(kind: NodeKind, root: string, ref: string, label: string, rest: Partial<TreeNode> = {}): TreeNode {
  return { kind, id: `${root}|${kind}|${ref}`, label, running: false, root, ref, error: false, children: [], ...rest };
}

function section(root: string, name: string, children: TreeNode[]): TreeNode[] {
  return children.length ? [row("section", root, name, name, { description: String(children.length), children })] : [];
}

// by name alone, so a row never moves when what runs changes
const byName = (a: TreeNode, b: TreeNode) => a.label.localeCompare(b.label);

const LANGUAGE: Record<string, string> = { cmake: "C++", python: "Python", csharp: "C#", rust: "Rust" };

const slash = (p: string) => p.split(path.sep).join("/");
const relative = (from: string, to: string) => slash(path.relative(from, to)) || ".";

/** "Rant 0.0.22", or "no Rant" where it can be added. A pin with no version says nothing. */
function rantText(version: string | null, hasRant: boolean): string {
  return version ? `Rant ${version}` : hasRant ? "" : "no Rant";
}

/** A build file or venv `rant ls libraries` lists for Rant, labelled from the folder it sits in. */
function buildRow(w: WorkspaceData, u: LibUse, from: string): TreeNode {
  const venv = u.how === "venv";
  // a venv without Rant takes none. Any other use names Rant, a version or not.
  const hasRant = u.version !== null || !venv;
  const label = venv ? relative(from, u.file) : relative(from, u.folder);
  return row("build", w.root, relative(w.root, u.file), label, {
    description: [venv ? "" : LANGUAGE[u.kind] ?? u.kind, rantText(u.version, hasRant)].filter(Boolean).join(", "),
    tooltip: u.file,
    path: u.file,
    open: venv ? undefined : u.file,
    lib: relative(w.root, u.folder),
    hasRant,
  });
}

function nodeRow(w: WorkspaceData, n: NodeEntry, label: string): TreeNode {
  return row("node", w.root, n.name, label, { running: n.running, nodeType: n.type, tooltip: n.type });
}

function packageRow(w: WorkspaceData, p: PackageInfo, nodes: TreeNode[], groups: TreeNode[]): TreeNode {
  const here = w.uses.filter((u) => pathKey(u.folder) === pathKey(p.folder));
  const own = new Set(p.files.map((f) => pathKey(f)));
  const builds = p.files.some((f) => path.basename(f) !== "package.rant");
  const hasRant = builds ? p.rant !== null || here.some((u) => u.how !== "venv" && own.has(pathKey(u.file))) : undefined;
  const languages = p.kinds.flatMap((k) => LANGUAGE[k] ?? []).join(", ");
  const extra = here.filter((u) => !own.has(pathKey(u.file))).map((u) => buildRow(w, u, p.folder));
  return row("package", w.root, p.name, p.name, {
    description: [languages, builds ? rantText(p.rant, hasRant ?? false) : ""].filter(Boolean).join(", "),
    tooltip: p.folder,
    path: p.folder,
    open: p.files[0],
    lib: builds ? relative(w.root, p.folder) : undefined,
    hasRant,
    running: nodes.some((n) => n.running) || groups.some((g) => g.running),
    installed: p.installed || undefined,
    children: [...nodes.sort(byName), ...extra.sort(byName), ...groups.sort(byName)],
  });
}

function groupRow(w: WorkspaceData, g: GroupInfo): TreeNode {
  const at = `${w.root}|group|${g.name}`;
  // a group runs on its own, or inside the run of a group that includes it
  const runs = (n: NodeEntry) => n.running && (n.groups.includes(g.name) || n.group === g.name);
  const members = g.nodes.map((m) =>
    row("node", w.root, m.name, m.name, {
      id: `${at}|node|${m.name}`,
      running: w.listing.nodes.some((n) => runs(n) && n.name === m.name),
      nodeType: m.type,
      member: true,
      tooltip: m.type,
    }),
  );
  // an include points at the group's own row rather than nesting what it runs
  const includes = g.includes.map((name, i) =>
    row("include", w.root, name, name, {
      id: `${at}|include|${i}`,
      tooltip: `Go to ${name}`,
      running: w.listing.nodes.some((n) => n.running && n.group === name && n.groups.includes(g.name)),
    }),
  );
  return row("group", w.root, g.name, g.name, {
    running: w.listing.runningGroups.includes(g.name) || w.listing.nodes.some((n) => n.running && n.group === g.name),
    description: g.description || g.params,
    tooltip: g.file,
    path: g.file,
    open: g.file,
    children: [...members, ...includes],
  });
}

function workspaceRow(w: WorkspaceData): TreeNode {
  if (w.error) return row("workspace", w.root, w.root, w.name, { description: w.error, tooltip: `${w.root}\n${w.error}`, error: true });

  const owner = (type: string) => w.packages.find((p) => type.startsWith(`${p.name}/`) && !type.slice(p.name.length + 1).includes("/"));
  const nodesOf = new Map<string, TreeNode[]>(w.packages.map((p) => [p.name, []]));
  const loose: TreeNode[] = [];
  for (const n of w.listing.nodes) {
    const p = owner(n.type);
    if (p) nodesOf.get(p.name)?.push(nodeRow(w, n, n.running ? n.name : n.type.slice(p.name.length + 1)));
    else loose.push(nodeRow(w, n, n.name));
  }
  // an installed package holds its own groups, apart from the workspace's
  const packageOf = (group: string) => group.slice(0, Math.max(group.indexOf("/"), 0));
  const groupsOf = new Map<string, TreeNode[]>(w.packages.filter((p) => p.installed).map((p) => [p.name, []]));
  const groups: TreeNode[] = [];
  for (const g of w.groups) (groupsOf.get(packageOf(g.name)) ?? groups).push(groupRow(w, g));
  const rows = (keep: boolean) =>
    w.packages.filter((p) => p.installed === keep).map((p) => packageRow(w, p, nodesOf.get(p.name) ?? [], groupsOf.get(p.name) ?? []));
  const packages = rows(false).sort(byName);
  const fromHome = rows(true).sort(byName);

  const folders = new Set(w.packages.map((p) => pathKey(p.folder)));
  const outside = [...w.uses.filter((u) => !folders.has(pathKey(u.folder))).map((u) => buildRow(w, u, w.root)), ...loose].sort(byName);

  groups.sort(byName);

  const count = w.listing.nodes.filter((n) => n.running).length;
  return row("workspace", w.root, w.root, w.name, {
    running: count > 0,
    description: count ? `${count} running` : undefined,
    tooltip: w.root,
    children: [
      ...section(w.root, "Packages", packages),
      ...section(w.root, "Outside packages", outside),
      ...section(w.root, "Groups", groups),
      ...section(w.root, "Installed", fromHome),
    ],
  });
}

export function buildTree(workspaces: WorkspaceData[]): TreeNode[] {
  return workspaces.map(workspaceRow);
}

/** Every row by id with its parent, for revealing one. */
export function parents(tree: TreeNode[]): Map<string, TreeNode | undefined> {
  const out = new Map<string, TreeNode | undefined>();
  const walk = (nodes: TreeNode[], parent?: TreeNode) => {
    for (const n of nodes) {
      out.set(n.id, parent);
      walk(n.children, n);
    }
  };
  walk(tree);
  return out;
}
