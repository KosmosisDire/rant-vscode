import * as path from "node:path";

/** One line of `rant ls packages --json`. */
export interface PackageInfo {
  name: string;
  kinds: string[];
  folder: string;
  /** Its build files, then its package.rant if it has one. */
  files: string[];
  rant: string | null;
}

/** One line of `rant lib --json`: a build file or venv that takes Rant, or could. */
export interface LibUse {
  folder: string;
  kind: string;
  /** CPM, FetchContent, find_package, pyproject, venv, PackageReference or ProjectReference. */
  how: string;
  version: string | null;
  /** The build file, or the venv folder. */
  file: string;
}

/** A node a group's own block starts, as the param defaults name it. */
export interface GroupNode {
  name: string;
  /** The node type, `package/node` or the path of a file outside every package. */
  type: string;
}

/** One line of `rant ls groups --json`. */
export interface GroupInfo {
  name: string;
  file: string;
  description: string;
  params: string;
  /** The groups it includes, by full name. */
  includes: string[];
  nodes: GroupNode[];
}

/** A node the workspace could start (name is the type, `package/node`) or one it started (name is its mesh name). */
export interface NodeEntry {
  name: string;
  /** `package/node`, or the path of a file outside every package. */
  type: string;
  running: boolean;
  groups: string[];
  kind?: string;
}

export interface NodeListing {
  nodes: NodeEntry[];
  /** Group names with a run going, without the `key=value` params of a second run. */
  runningGroups: string[];
}

export interface SourceTarget {
  file: string;
  /** Text to put the cursor on in the file. */
  find?: string;
}

type Json = Record<string, unknown>;

function bad(what: string): never {
  throw new Error(`unexpected output of rant ${what}`);
}

function object(v: unknown, what: string): Json {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : bad(what);
}

function list(v: unknown, what: string): unknown[] {
  return Array.isArray(v) ? v : bad(what);
}

function text(v: unknown, what: string): string {
  return typeof v === "string" ? v : bad(what);
}

function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return bad(what);
  }
}

export function parsePackages(raw: string): PackageInfo[] {
  const what = "ls packages";
  return list(parseJson(raw, what), what).map((e) => {
    const o = object(e, what);
    return {
      name: text(o.name, what),
      kinds: list(o.kinds, what).map((k) => text(k, what)),
      folder: text(o.folder, what),
      files: list(o.files, what).map((f) => text(f, what)),
      rant: typeof o.rant === "string" ? o.rant : null,
    };
  });
}

export function parseUses(raw: string): LibUse[] {
  const what = "lib";
  return list(parseJson(raw, what), what).map((e) => {
    const o = object(e, what);
    return {
      folder: text(o.folder, what),
      kind: text(o.kind, what),
      how: text(o.how, what),
      version: typeof o.version === "string" ? o.version : null,
      file: text(o.file, what),
    };
  });
}

export function parseGroups(raw: string): GroupInfo[] {
  const what = "ls groups";
  return list(parseJson(raw, what), what).map((e) => {
    const o = object(e, what);
    return {
      name: text(o.name, what),
      file: text(o.file, what),
      description: text(o.description, what),
      params: text(o.params, what),
      includes: list(o.includes, what).map((i) => text(i, what)),
      nodes: list(o.nodes, what).map((n) => {
        const r = object(n, what);
        return { name: text(r.name, what), type: text(r.type, what) };
      }),
    };
  });
}

/** The output of `rant ls nodes --no-mesh --json`: started nodes under their groups or loose, then the ones that could start. */
export function parseNodes(raw: string): NodeListing {
  const what = "ls nodes";
  const o = object(parseJson(raw, what), what);
  const byName = new Map<string, NodeEntry>();
  const runningGroups: string[] = [];
  const running = (row: unknown, group?: string) => {
    const r = object(row, what);
    const name = text(r.name, what);
    const entry = byName.get(name) ?? { name, type: text(r.type, what), running: true, groups: [] };
    if (group && !entry.groups.includes(group)) entry.groups.push(group);
    byName.set(name, entry);
  };
  for (const g of list(o.groups, what)) {
    const go = object(g, what);
    // a second run of one group shows as `Name key=value`
    const group = text(go.group, what).split(" ")[0] ?? "";
    if (!runningGroups.includes(group)) runningGroups.push(group);
    for (const n of list(go.nodes, what)) running(n, group);
  }
  for (const n of list(o.nodes, what)) running(n);
  const nodes = [...byName.values()];
  for (const n of list(o.not_running ?? [], what)) {
    const r = object(n, what);
    const name = text(r.name, what);
    nodes.push({ name, type: name, running: false, groups: [], kind: text(r.kind, what) });
  }
  return { nodes, runningGroups };
}

/** Where a node's source is, from `rant info node <name> --json` run in the workspace root. */
export function parseSource(raw: string, root: string): SourceTarget | undefined {
  const what = "info node";
  const entries = list(parseJson(raw, what), what).map((e) => object(e, what));
  for (const e of entries) {
    if (typeof e.source === "string") return { file: path.resolve(root, e.source) };
  }
  for (const e of entries) {
    if (e.kind === "declared" && typeof e.node === "string" && typeof e.cwd === "string") {
      const name = e.node.split("/").pop() ?? e.node;
      return { file: path.resolve(root, e.cwd, "package.rant"), find: `node "${name}"` };
    }
  }
  return undefined;
}
