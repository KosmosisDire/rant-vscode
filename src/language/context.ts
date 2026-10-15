import type { WorkspaceData } from "../workspaces/load.ts";
import { pathKey } from "../workspaces/paths.ts";
import { PATH_NAMES, scopeOf } from "./vocabulary.ts";
import type { Entry, FileKind } from "./vocabulary.ts";

/** What the workspace around a file holds, each named as that file would write it. */
export interface Known {
  /** Node types a group's `node` block can name. */
  nodes: Entry[];
  /** Groups an `include` can name, this file's own left out, with the params each takes. */
  groups: Array<Entry & { params: string[] }>;
  /** Packages a `depend` can name, the file's own left out. */
  packages: Entry[];
}

const NOTHING: Known = { nodes: [], groups: [], packages: [] };

const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name);

/** The names a file can write, bare for what sits in its own package as the CLI looks there first. */
export function knownFrom(w: WorkspaceData, file: string): Known {
  const key = pathKey(file);
  const here = w.packages
    .filter((p) => key.startsWith(pathKey(p.folder) + "/"))
    .sort((a, b) => b.folder.length - a.folder.length)[0]?.name;
  const written = (name: string) => (here && name.startsWith(`${here}/`) ? name.slice(here.length + 1) : name);
  const types = new Map<string, string | undefined>();
  for (const n of w.listing.nodes) {
    // a running file outside every package is known by its path, which a group does not write
    if (/^([A-Za-z]:)?\//.test(n.type)) continue;
    if (!types.has(n.type) || n.kind) types.set(n.type, n.kind);
  }
  return {
    nodes: [...types].map(([t, kind]) => ({ name: written(t), doc: kind ? `${t}, ${kind}` : t })).sort(byName),
    groups: w.groups
      .filter((g) => pathKey(g.file) !== key)
      .map((g) => ({
        name: written(g.name),
        doc: g.description || g.name,
        params: g.params.split(" ").flatMap((p) => p.split("=")[0] || []),
      }))
      .sort(byName),
    packages: w.packages.filter((p) => p.name !== here).map((p) => ({ name: p.name, doc: p.folder })).sort(byName),
  };
}

/** Index just past a string, comment or heredoc opening at i, or -1 when none opens there. */
function skipped(text: string, i: number): number {
  const c = text[i];
  const next = text[i + 1];
  if (c === "#" || (c === "/" && next === "/")) {
    const end = text.indexOf("\n", i);
    return end === -1 ? text.length + 1 : end;
  }
  if (c === "/" && next === "*") {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length + 1 : end + 2;
  }
  if (c === '"') return endOfString(text, i);
  if (c === "<" && next === "<") {
    const m = /^<<-?([A-Za-z_][\w-]*)[ \t]*\r?\n/.exec(text.slice(i, i + 200));
    if (!m) return -1;
    const end = new RegExp(`^[ \\t]*${m[1]}[ \\t]*$`, "m").exec(text.slice(i + m[0].length));
    return end ? i + m[0].length + end.index + end[0].length : text.length + 1;
  }
  return -1;
}

interface Frame {
  /** The block's type, null for an object, list or call. */
  block: string | null;
  /** The label of a block, such as the group an include names. */
  label?: string;
  /** Just past the `{`. */
  start: number;
}

/** The open frames at offset, innermost last, or null inside a string, comment or heredoc. */
function framesAt(text: string, offset: number): Frame[] | null {
  const stack: Frame[] = [];
  let i = 0;
  while (i < offset) {
    const end = skipped(text, i);
    // a line comment runs to the end of its line, so the cursor there is still in it
    const comment = text[i] === "#" || text.startsWith("//", i);
    if (end > offset || (comment && end === offset)) return null;
    if (end !== -1) {
      i = end;
      continue;
    }
    const c = text[i];
    if (c === "{") {
      const lineStart = text.lastIndexOf("\n", i - 1) + 1;
      const header = /^\s*([A-Za-z_][\w-]*)((?:\s+(?:"[^"\n]*"|[A-Za-z_][\w-]*))*)\s*$/.exec(text.slice(lineStart, i));
      const label = header?.[2] ? /"([^"\n]*)"/.exec(header[2])?.[1] : undefined;
      stack.push({ block: header?.[1] ?? null, label, start: i + 1 });
    } else if (c === "[" || c === "(") stack.push({ block: null, start: i + 1 });
    else if (c === "}" || c === "]" || c === ")") stack.pop();
    i++;
  }
  return stack;
}

/**
 * The block the offset is in: undefined at the top of the file, the block's type inside one,
 * and null where nothing should be suggested (strings, comments, heredocs, objects, lists).
 */
export function blockAt(text: string, offset: number): string | undefined | null {
  const frames = framesAt(text, offset);
  if (!frames) return null;
  return frames.length ? frames[frames.length - 1]?.block ?? null : undefined;
}

/** The keys already set in the body that starts at start, up to its closing brace. */
function keysIn(text: string, start: number): Set<string> {
  const out = new Set<string>();
  let depth = 0;
  let i = start;
  let lineStart = start;
  while (i < text.length) {
    const end = skipped(text, i);
    if (end !== -1) {
      i = end;
      continue;
    }
    const c = text[i];
    if (c === "\n") lineStart = i + 1;
    else if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      if (depth === 0) break;
      depth--;
    } else if (c === "=" && depth === 0) {
      const key = /^\s*([A-Za-z_][\w-]*)\s*$/.exec(text.slice(lineStart, i))?.[1];
      if (key) out.add(key);
    }
    i++;
  }
  return out;
}

export interface Suggestion {
  kind: "attribute" | "block" | "value" | "variable";
  label: string;
  doc: string;
  /** Snippet text with $0 and ${1:label} stops. */
  insert: string;
  /** Show what can follow once it is in. */
  more?: boolean;
}

const value = (e: Entry): Suggestion => ({ kind: "value", label: e.name, doc: e.doc, insert: e.name });

/** What a label can name in a file of the given kind and block, none where the label is new. */
function labelValues(kind: FileKind, block: string, known: Known): Entry[] {
  if (kind !== "group") return [];
  if (block === "node") return known.nodes;
  if (block === "include") return known.groups;
  return [];
}

/** The suggestions for the cursor at `offset` of a file of the given kind. */
export function suggest(kind: FileKind, text: string, offset: number, known: Known = NOTHING): Suggestion[] {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);

  // inside the label of a block header, or a string in a list value, the line's own frame counts
  const label = /^\s*([A-Za-z_][\w-]*)\s+"[^"]*$/.exec(prefix);
  if (label) {
    const outer = framesAt(text, lineStart);
    return outer && outer.length === 0 ? labelValues(kind, label[1] ?? "", known).map(value) : [];
  }
  const listed = /^\s*([A-Za-z_][\w-]*)\s*=\s*\[[^\]]*"[^"]*$/.exec(prefix);
  if (listed && (prefix.match(/"/g)?.length ?? 0) % 2 === 1) {
    const outer = framesAt(text, lineStart);
    const top = outer?.length === 0;
    if (kind === "package" && top && listed[1] === "depend") return known.packages.map(value);
    const inc = outer?.[outer.length - 1];
    if (kind === "group" && inc?.block === "include" && listed[1] === "expose") {
      const g = known.groups.find((x) => x.name === inc.label);
      return (g?.params ?? []).map((p) => value({ name: p, doc: `A param of ${g?.name}.` }));
    }
    return [];
  }

  const frames = framesAt(text, offset);
  if (!frames) return [];
  const frame = frames[frames.length - 1];
  if (frame && frame.block === null) return [];
  const scope = scopeOf(kind, frame?.block ?? undefined);

  if (/^\s*[A-Za-z_-]*$/.test(prefix)) {
    const set = keysIn(text, frame?.start ?? 0);
    const attrs = [...scope.attributes];
    // an include binds the params of the group it names
    if (kind === "group" && frame?.block === "include") {
      const g = known.groups.find((x) => x.name === frame.label);
      for (const p of g?.params ?? []) attrs.push({ name: p, doc: `Sets param ${p} of ${g?.name}.` });
    }
    const keys = attrs
      .filter((a) => !set.has(a.name))
      .map<Suggestion>((a) => ({ kind: "attribute", label: a.name, doc: a.doc, insert: `${a.name} = `, more: true }));
    const blocks = scope.blocks.map<Suggestion>((b) => {
      const named = labelValues(kind, b.name, known).length > 0;
      return {
        kind: "block",
        label: b.name,
        doc: b.doc,
        insert: named ? `${b.name} "$1" {\n\t$0\n}` : `${b.name} "\${1:${b.label}}" {\n\t$0\n}`,
        more: named,
      };
    });
    return [...keys, ...blocks];
  }

  const assigned = /^\s*([A-Za-z_][\w-]*)\s*=\s*[\w.]*$/.exec(prefix);
  if (!assigned) return [];
  const attr = scope.attributes.find((a) => a.name === assigned[1]);
  const out: Suggestion[] = (attr?.values ?? []).map((v) => ({ kind: "value", label: v, doc: attr?.doc ?? "", insert: v }));
  // a param is only read in a group, and a param block is not an expression
  if (attr?.values === undefined) {
    out.push(...PATH_NAMES.map<Suggestion>((p) => ({ kind: "variable", label: p.name, doc: p.doc, insert: p.name })));
    if (kind === "group") {
      for (const m of text.matchAll(/^\s*param\s+"([^"\n]+)"/gm)) {
        out.push({ kind: "variable", label: `param.${m[1]}`, doc: `The value of param ${m[1]}.`, insert: `param.${m[1]}` });
      }
    }
  }
  return out;
}

/** Index just past the string that opens at `start`, interpolations included. */
function endOfString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") i += 2;
    else if (c === '"' || c === "\n") return i + 1;
    else if (c === "$" && text[i + 1] === "{") i = endOfInterpolation(text, i + 2);
    else i++;
  }
  return text.length + 1;
}

function endOfInterpolation(text: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '"') i = endOfString(text, i);
    else {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
  }
  return depth > 0 ? text.length + 1 : i;
}
