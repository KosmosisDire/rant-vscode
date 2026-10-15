import type { WorkspaceData } from "../../workspaces/load.ts";

export type NodeKind = "workspace" | "section" | "package" | "node" | "group";

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
  /** What the CLI takes for this row: a package, node or group name. */
  ref: string;
  /** The folder of a package or the file of a group. */
  path?: string;
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

function workspaceRow(w: WorkspaceData): TreeNode {
  if (w.error) return row("workspace", w.root, w.root, w.name, { description: w.error, tooltip: `${w.root}\n${w.error}`, error: true });

  const packages = w.packages.map((p) =>
    row("package", w.root, p.name, p.name, {
      description: [p.kinds.join(", "), p.rant ? `Rant ${p.rant}` : "no Rant"].filter(Boolean).join(", "),
      tooltip: p.folder,
      path: p.folder,
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
      });
    })
    .sort(byRunningThenName);

  const count = nodes.filter((n) => n.running).length;
  return row("workspace", w.root, w.root, w.name, {
    running: count > 0,
    description: count ? `${count} running` : undefined,
    tooltip: w.root,
    children: [...section(w.root, "Packages", packages), ...section(w.root, "Nodes", nodes), ...section(w.root, "Groups", groups)],
  });
}

export function buildTree(workspaces: WorkspaceData[]): TreeNode[] {
  return workspaces.map(workspaceRow);
}
