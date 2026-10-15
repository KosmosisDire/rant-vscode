import * as path from "node:path";

import type { WorkspaceData } from "../../workspaces/load.ts";
import { pathKey } from "../../workspaces/paths.ts";

export type NodeKind = "workspace" | "section" | "package" | "node" | "group" | "build";

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
  /** What the CLI takes for this row: a package, node or group name, or a build system's folder. */
  ref: string;
  /** The folder of a package, the file of a group, the build file or venv of a build system. */
  path?: string;
  /** The file a click opens. */
  open?: string;
  /** A build system that takes Rant, so it can be updated rather than added to. */
  hasRant?: boolean;
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

function byRunningThenName(a: TreeNode, b: TreeNode): number {
  return Number(b.running) - Number(a.running) || a.label.localeCompare(b.label);
}

const slash = (p: string) => p.split(path.sep).join("/");

/** What `rant lib` lists, then the package build files that do not take Rant yet. */
function buildRows(w: WorkspaceData): TreeNode[] {
  const rel = (p: string) => slash(path.relative(w.root, p)) || ".";
  const buildRow = (file: string, folder: string, how: string, version: string | null) => {
    // a venv without Rant, or a build file rant lib does not list, takes none. Otherwise a missing version is unpinned.
    const hasRant = version !== null || (how !== "venv" && how !== "");
    const rant = version ? `Rant ${version}` : hasRant ? "Rant unpinned" : "no Rant";
    return row("build", w.root, rel(file), rel(file), {
      ref: rel(folder),
      description: [how, rant].filter(Boolean).join(", "),
      tooltip: file,
      path: file,
      open: how === "venv" ? undefined : file,
      hasRant,
    });
  };
  const listed = new Set(w.uses.map((u) => pathKey(u.file)));
  const bare = w.packages.flatMap((p) =>
    p.files
      .filter((f) => path.basename(f) !== "package.rant" && !listed.has(pathKey(f)))
      .map((f) => buildRow(f, path.dirname(f), "", null)),
  );
  return [...w.uses.map((u) => buildRow(u.file, u.folder, u.how, u.version)), ...bare].sort((a, b) => a.label.localeCompare(b.label));
}

function workspaceRow(w: WorkspaceData): TreeNode {
  if (w.error) return row("workspace", w.root, w.root, w.name, { description: w.error, tooltip: `${w.root}\n${w.error}`, error: true });

  const packages = w.packages.map((p) =>
    row("package", w.root, p.name, p.name, {
      description: [p.kinds.join(", "), p.rant ? `Rant ${p.rant}` : "no Rant"].filter(Boolean).join(", "),
      tooltip: p.folder,
      path: p.folder,
      open: p.files[0],
    }),
  );
  const nodes = w.listing.nodes
    .map((n) =>
      row("node", w.root, n.name, n.name, {
        running: n.running,
        description: n.running ? ["running", ...n.groups].join(", ") : n.kind,
        tooltip: n.name,
      }),
    )
    .sort(byRunningThenName);
  const groups = w.groups
    .map((g) => {
      const running = w.listing.runningGroups.includes(g.name);
      return row("group", w.root, g.name, g.name, {
        running,
        description: [running ? "running" : "", g.description || g.params].filter(Boolean).join(", "),
        tooltip: g.file,
        path: g.file,
        open: g.file,
      });
    })
    .sort(byRunningThenName);

  const count = nodes.filter((n) => n.running).length;
  return row("workspace", w.root, w.root, w.name, {
    running: count > 0,
    description: count ? `${count} running` : undefined,
    tooltip: w.root,
    children: [
      ...section(w.root, "Packages", packages),
      ...section(w.root, "Build systems", buildRows(w)),
      ...section(w.root, "Nodes", nodes),
      ...section(w.root, "Groups", groups),
    ],
  });
}

export function buildTree(workspaces: WorkspaceData[]): TreeNode[] {
  return workspaces.map(workspaceRow);
}
