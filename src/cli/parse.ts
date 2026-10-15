import * as path from "node:path";

/** One line of `rant ls packages --json`. */
export interface PackageInfo {
  name: string;
  kinds: string[];
  folder: string;
  rant: string | null;
}

/** One line of `rant ls groups --json`. */
export interface GroupInfo {
  name: string;
  file: string;
  description: string;
  params: string;
}

/** A node the workspace could start (name is the type, `package/node`) or one on the mesh (name is its mesh name). */
export interface NodeEntry {
  name: string;
  running: boolean;
  onMesh: boolean;
  groups: string[];
  /** On the mesh but not started by this workspace, such as a node of another workspace. */
  external: boolean;
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
      rant: typeof o.rant === "string" ? o.rant : null,
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
    };
  });
}

/** The names of the nodes a workspace started, from its `.rant/state` file. Empty when the file is not readable. */
export function parseStartedNames(raw: string): Set<string> {
  try {
    const instances = (JSON.parse(raw) as { instances?: Array<{ name?: unknown }> }).instances ?? [];
    return new Set(instances.flatMap((i) => (typeof i.name === "string" ? [i.name] : [])));
  } catch {
    return new Set();
  }
}

/**
 * The output of `rant ls nodes --json`: running nodes under their groups or loose, then the ones
 * that could start. A loose node is the workspace's own only when `started` names it.
 */
export function parseNodes(raw: string, started: ReadonlySet<string> = new Set()): NodeListing {
  const what = "ls nodes";
  const o = object(parseJson(raw, what), what);
  const byName = new Map<string, NodeEntry>();
  const runningGroups: string[] = [];
  const running = (row: unknown, group?: string) => {
    const r = object(row, what);
    const name = text(r.name, what);
    const entry = byName.get(name) ?? { name, running: true, onMesh: r.on_mesh === true, groups: [], external: false };
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
  for (const n of list(o.nodes, what)) {
    running(n);
    const entry = byName.get(text(object(n, what).name, what));
    if (entry && entry.groups.length === 0) entry.external = !started.has(entry.name);
  }
  const nodes = [...byName.values()];
  for (const n of list(o.not_running ?? [], what)) {
    const r = object(n, what);
    nodes.push({ name: text(r.name, what), running: false, onMesh: false, groups: [], external: false, kind: text(r.kind, what) });
  }
  return { nodes, runningGroups };
}

/** Where a node's source is, from `rant info node <name> --json` run in the workspace root. */
export function parseSource(raw: string, root: string): SourceTarget | undefined {
  const what = "info node";
  const entries = list(parseJson(raw, what), what).map((e) => object(e, what));
  for (const e of entries) {
    if (typeof e.file === "string") return { file: path.resolve(root, e.file) };
  }
  for (const e of entries) {
    if (e.kind === "declared" && typeof e.node === "string" && typeof e.cwd === "string") {
      const name = e.node.split("/").pop() ?? e.node;
      return { file: path.resolve(root, e.cwd, "package.rant"), find: `node "${name}"` };
    }
  }
  return undefined;
}
