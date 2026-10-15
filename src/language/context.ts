import { PATH_NAMES, scopeOf } from "./vocabulary.ts";
import type { Entry, FileKind } from "./vocabulary.ts";

/**
 * The block the offset is in: undefined at the top of the file, the block's type inside one,
 * and null where nothing should be suggested (strings, comments, heredocs, objects, lists).
 */
export function blockAt(text: string, offset: number): string | undefined | null {
  const stack: Array<string | null> = [];
  let i = 0;
  while (i < offset) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (c === "#" || (c === "/" && next === "/")) {
      const end = text.indexOf("\n", i);
      if (end === -1 || end >= offset) return null;
      i = end;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1 || end + 2 > offset) return null;
      i = end + 2;
    } else if (c === '"') {
      const end = endOfString(text, i);
      if (end > offset) return null;
      i = end;
    } else if (c === "<" && next === "<") {
      const m = /^<<-?([A-Za-z_][\w-]*)[ \t]*\r?\n/.exec(text.slice(i, i + 200));
      if (!m) {
        i += 2;
        continue;
      }
      const end = new RegExp(`^[ \\t]*${m[1]}[ \\t]*$`, "m").exec(text.slice(i + m[0].length));
      if (!end) return null;
      const after = i + m[0].length + end.index + end[0].length;
      if (after > offset) return null;
      i = after;
    } else if (c === "{") {
      const lineStart = text.lastIndexOf("\n", i - 1) + 1;
      const header = /^\s*([A-Za-z_][\w-]*)(?:\s+(?:"[^"\n]*"|[A-Za-z_][\w-]*))*\s*$/.exec(text.slice(lineStart, i));
      stack.push(header?.[1] ?? null);
      i++;
    } else if (c === "[" || c === "(") {
      stack.push(null);
      i++;
    } else if (c === "}" || c === "]" || c === ")") {
      stack.pop();
      i++;
    } else {
      i++;
    }
  }
  return stack.length ? stack[stack.length - 1] ?? null : undefined;
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

export interface Suggestion {
  kind: "attribute" | "block" | "value" | "variable";
  label: string;
  doc: string;
  /** Snippet text with $0 and ${1:label} stops. */
  insert: string;
}

function attribute(e: Entry): Suggestion {
  return { kind: "attribute", label: e.name, doc: e.doc, insert: `${e.name} = ` };
}

/** The suggestions for the cursor at `offset` of a file of the given kind. */
export function suggest(kind: FileKind, text: string, offset: number): Suggestion[] {
  const block = blockAt(text, offset);
  if (block === null) return [];
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);
  const scope = scopeOf(kind, block);

  if (/^\s*[A-Za-z_-]*$/.test(prefix)) {
    const blocks = scope.blocks.map<Suggestion>((b) => ({
      kind: "block",
      label: b.name,
      doc: b.doc,
      insert: `${b.name} "\${1:${b.label}}" {\n\t$0\n}`,
    }));
    return [...scope.attributes.map(attribute), ...blocks];
  }

  const value = /^\s*([A-Za-z_][\w-]*)\s*=\s*[\w.]*$/.exec(prefix);
  if (!value) return [];
  const known = scope.attributes.find((a) => a.name === value[1]);
  const out: Suggestion[] = (known?.values ?? []).map((v) => ({ kind: "value", label: v, doc: known?.doc ?? "", insert: v }));
  // a param is only read in a group, and a param block is not an expression
  if (known?.values === undefined) {
    out.push(...PATH_NAMES.map<Suggestion>((p) => ({ kind: "variable", label: p.name, doc: p.doc, insert: p.name })));
    if (kind === "group") {
      for (const m of text.matchAll(/^\s*param\s+"([^"\n]+)"/gm)) {
        out.push({ kind: "variable", label: `param.${m[1]}`, doc: `The value of param ${m[1]}.`, insert: `param.${m[1]}` });
      }
    }
  }
  return out;
}
