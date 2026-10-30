export type FileKind = "workspace" | "package" | "group";

export interface Entry {
  name: string;
  doc: string;
  /** Values the attribute takes, when it is a closed set. */
  values?: string[];
}

export interface BlockEntry extends Entry {
  /** What the label of the block names. */
  label: string;
  attributes: Entry[];
}

export interface Scope {
  attributes: Entry[];
  blocks: BlockEntry[];
}

// Keys and blocks come from cli-rant/config/src: workspace.rs, package.rs, group.rs, param.rs, placement.rs, plan.rs.
// The docs come from the crate's comments and cli-rant/skill/SKILL.md.

const domain: Entry = { name: "domain", doc: "The Rant domain nodes start on, a number from 0 to 65535. The innermost one wins." };
const prefix: Entry = {
  name: "prefix",
  doc: "Goes in front of every entity name a node makes. Prefixes join from the outside in. It cannot be empty, contain @, or start or end with /.",
};
const nodePrefix: Entry = {
  name: "node_prefix",
  doc: "Goes in front of the node name. Prefixes join from the outside in. A full node name holds 32 bytes at most.",
};
const placement: Entry[] = [domain, prefix, nodePrefix];
const restart: Entry = {
  name: "restart",
  doc: 'Whether a node that exits starts again: "never" (the default), "on-failure" (unless it exited with 0) or "always". The service process of rant starts it again. The innermost wins.',
  values: ['"never"', '"on-failure"', '"always"'],
};

const workspace: Scope = {
  attributes: [
    { name: "logs", doc: 'Folder for the output of started nodes, one `<node>.log` each. Default "logs".' },
    { name: "ignore", doc: 'List of globs for folders discovery skips, such as ["third_party/**"].' },
    ...placement,
  ],
  blocks: [],
};

const packageNode: BlockEntry = {
  name: "node",
  label: "node name",
  doc: "A program rant cannot find itself. The label is the node name and `run` is required.",
  attributes: [
    { name: "run", doc: "The command, a string or a list. `${path.package}` is the package folder." },
    {
      name: "expect_mesh",
      doc: "false for a program that never joins the mesh, so `rant run` waits only for it to start. Default true.",
      values: ["true", "false"],
    },
  ],
};

const pkg: Scope = {
  attributes: [
    { name: "name", doc: "The package name, which `rant install` needs. Default: the name in its build file, else the folder name." },
    { name: "description", doc: "What the package is for, shown by `rant info package`." },
    { name: "build", doc: "Commands run in order, replacing the default build. A string or a list of strings." },
    { name: "depend", doc: "Names of packages built first." },
    { name: "ignore", doc: "List of globs, relative to the package, that node discovery skips." },
    { name: "python", doc: "The interpreter of the package's Python nodes, relative to the package folder." },
    ...placement,
  ],
  blocks: [packageNode],
};

const param: BlockEntry = {
  name: "param",
  label: "param name",
  doc: "A value the group takes, set with `rant run Group key=value`. Read it as `param.<name>`.",
  attributes: [
    { name: "type", doc: "The type of the value. Default string. A path counts from where it is given.", values: ["string", "int", "float", "bool", "path"] },
    { name: "options", doc: "List of the values allowed." },
    { name: "default", doc: "The value when none is given. Without one the param is required." },
    { name: "description", doc: "What the param does, shown by `rant run Group --help`." },
  ],
};

const include: BlockEntry = {
  name: "include",
  label: "group name",
  doc: "Another group started with this one. Other attributes set its params by name.",
  attributes: [
    { name: "expose", doc: "true passes every unset param of the included group up, or a list of the names to pass.", values: ["true", "false"] },
    ...placement,
    restart,
  ],
};

const groupNode: BlockEntry = {
  name: "node",
  label: "node to run",
  doc: "A node to start. The label is the node to run, `package/name` when the name is unclear.",
  attributes: [
    { name: "name", doc: "The name on the mesh. The node's own name by default." },
    { name: "args", doc: "Arguments added after the node's command, a string or a list." },
    { name: "env", doc: 'Environment variables, an object such as { LEVEL = "debug" }.' },
    ...placement,
    restart,
  ],
};

const group: Scope = {
  attributes: [{ name: "description", doc: "What the group does, shown by `rant ls groups`." }, ...placement, restart],
  blocks: [param, include, groupNode],
};

export const FILE_SCOPES: Record<FileKind, Scope> = { workspace, package: pkg, group };

/** The names an expression may read, `param.<name>` only in a group. */
export const PATH_NAMES: Entry[] = [
  { name: "path.file", doc: "The folder of this file." },
  { name: "path.package", doc: "The folder of the package around this file." },
  { name: "path.workspace", doc: "The workspace folder." },
];

/** The editor languages of the config files: rant for *.rant, rant-group for *.run, so each has its own icon. */
export const LANGUAGE_IDS = ["rant", "rant-group"];

/** Which kind of file a name is, from workspace.rant, package.rant and *.run. */
export function fileKindOf(fileName: string): FileKind | undefined {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  if (base === "workspace.rant") return "workspace";
  if (base === "package.rant") return "package";
  if (base.endsWith(".run")) return "group";
  return undefined;
}

/** What may be written inside a block of the given name at the top, or the top itself when block is undefined. */
export function scopeOf(kind: FileKind, block: string | undefined): Scope {
  const top = FILE_SCOPES[kind];
  if (block === undefined) return top;
  const b = top.blocks.find((x) => x.name === block);
  return b ? { attributes: b.attributes, blocks: [] } : { attributes: [], blocks: [] };
}
