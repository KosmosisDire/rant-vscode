import type { CompiledSchema, FieldKind } from "rant-middleware";

/** One field of a schema as a page reads it: its dotted path, with `[]` past each array. An
 *  array's element is a row of its own, its path the array's with `[]`, named "". */
export interface SchemaRow {
  path: string;
  name: string;
  /** string is a capped string, vstring one of any length */
  kind: string;
  named?: string;
  count?: number;
  cap?: number;
  variants?: { name: string; value: number }[];
}

/** A schema as plain data, since a webview message is JSON. */
export interface SchemaBlock {
  name: string;
  hash: string;
  dsl: string;
  fields: SchemaRow[];
}

const KIND: Partial<Record<FieldKind, string>> = { str: "string", vstr: "vstring" };
const kindText = (k: FieldKind): string => KIND[k] ?? k;

/** A compiled schema as the page reads it. */
export function blockOf(s: CompiledSchema): SchemaBlock {
  const table = s.fields;
  const paths: string[] = [];
  const fields = table.map((f, i): SchemaRow => {
    // the nearest row one level up holds this one: an array's element adds [] to its path
    let parent = i - 1;
    while (parent >= 0 && table[parent]!.depth >= f.depth) parent--;
    const element = parent >= 0 && (table[parent]!.kind === "arr" || table[parent]!.kind === "varr");
    paths.push(parent < 0 ? f.name : element ? `${paths[parent]!}[]` : `${paths[parent]!}.${f.name}`);
    const row: SchemaRow = { path: paths[i]!, name: f.name, kind: kindText(f.kind) };
    if (f.typeName) row.named = f.typeName;
    if (f.kind === "arr") row.count = f.count;
    if (f.strCap) row.cap = f.strCap;
    if (f.kind === "enum") row.variants = s.enumVariants(i);
    return row;
  });
  return { name: s.name, hash: s.hash.toString(16).padStart(16, "0"), dsl: s.dsl, fields };
}

/** A schema's type in a few words: its name, a bare type's kind such as f64, or bytes when untyped. */
export function typeName(s: CompiledSchema | null): string {
  if (!s) return "bytes";
  const first = s.fields[0];
  return s.name || (first ? kindText(first.kind) : "value");
}

/** Where a value sits: member names and element indices from the root. */
export type Path = (string | number)[];
export type Editor = "" | "text" | "bool" | "enum";

/** One row of a value table, the way the explorer shows a value: Field, Type and Value. */
export interface Row {
  key: string;
  path: Path;
  depth: number;
  name: string;
  type: string;
  text: string;
  branch: boolean;
  open: boolean;
  /** How the value cell edits, empty when it shows text. */
  editor: Editor;
  /** The text an editor starts from: exact, where the shown text rounds. */
  edit: string;
  options?: string[];
  /** An element that can be taken out while editing. */
  remove?: boolean;
  /** The row that adds an element while editing. */
  add?: boolean;
  /** Elements left out of a long array. */
  more?: number;
  media?: "VideoFrame" | "Image";
}

/** Which branches the user opened or closed, and whether the cells edit. */
export interface View {
  open: Map<string, boolean>;
  editing: boolean;
}

/** As the explorer: an array this long starts closed, and only this many elements list. */
const WHOLE = 16;
const LISTED = 200;

const NUMERIC = ["u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64", "f32", "f64"];
const TYPED: Record<string, new (n: number) => ArrayLike<number | bigint>> = {
  u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, u64: BigUint64Array, i8: Int8Array,
  i16: Int16Array, i32: Int32Array, i64: BigInt64Array, f32: Float32Array, f64: Float64Array,
};
const RANGE: Record<string, [bigint, bigint]> = {
  u8: [0n, 255n], u16: [0n, 65535n], u32: [0n, 4294967295n], u64: [0n, 18446744073709551615n],
  i8: [-128n, 127n], i16: [-32768n, 32767n], i32: [-2147483648n, 2147483647n], i64: [-9223372036854775808n, 9223372036854775807n],
};

export const keyOf = (p: Path): string => JSON.stringify(p);

const parentOf = (schemaPath: string): string => (schemaPath.includes(".") ? schemaPath.slice(0, schemaPath.lastIndexOf(".")) : "");
// a struct's members, each named, never an array's element
const kids = (block: SchemaBlock, schemaPath: string): SchemaRow[] =>
  block.fields.filter((f) => f.name !== "" && f.path !== schemaPath && parentOf(f.path) === schemaPath);
/** An array row's element, the row at its path with [] after. */
const elemOf = (block: SchemaBlock, f: SchemaRow): SchemaRow | undefined => block.fields.find((x) => x.path === `${f.path}[]`);
// a bare type's first row is unnamed, where a struct's first is a named member
const bare = (block: SchemaBlock): SchemaRow | undefined => (block.fields[0] && !block.fields[0].name ? block.fields[0] : undefined);
const media = (named?: string): "VideoFrame" | "Image" | undefined => (named === "VideoFrame" || named === "Image" ? named : undefined);

/** A field's type as the schema text spells it, a list of lists as f32[3][]. */
function typeOf(block: SchemaBlock, f: SchemaRow): string {
  switch (f.kind) {
    case "struct":
    case "enum":
      return f.named ?? f.kind;
    case "string":
      return f.cap ? `string<${f.cap}>` : "string";
    case "vstring":
      return "string";
    case "arr":
    case "varr": {
      const e = elemOf(block, f);
      return `${f.named ?? (e ? typeOf(block, e) : "?")}[${f.kind === "arr" ? (f.count ?? "") : ""}]`;
    }
    default:
      return f.kind;
  }
}

/** A leaf as the explorer shows it: floats to 3 places, an empty string as `empty`. */
export function textOf(kind: string, v: unknown): string {
  if (v === undefined || v === null) return "";
  if ((kind === "f32" || kind === "f64") && typeof v === "number") return Number.isFinite(v) ? v.toFixed(3) : String(v);
  if (kind === "bool") return v ? "true" : "false";
  if ((kind === "string" || kind === "vstring") && v === "") return "empty";
  return String(v);
}

function editorOf(kind: string): Editor {
  if (kind === "bool") return "bool";
  if (kind === "enum") return "enum";
  return NUMERIC.includes(kind) || kind === "string" || kind === "vstring" ? "text" : "";
}

const listOf = (v: unknown): ArrayLike<unknown> => (Array.isArray(v) || ArrayBuffer.isView(v) ? (v as unknown as ArrayLike<unknown>) : []);

/** The rows of a value in tree order, closed branches skipped. A bare root lifts its children. */
export function tableRows(block: SchemaBlock | null | undefined, value: unknown, view: View): Row[] {
  const out: Row[] = [];
  if (!block) {
    const n = listOf(value).length;
    out.push({ key: "[]", path: [], depth: 0, name: "data", type: "bytes", text: `${n} bytes`, branch: false, open: false, editor: "", edit: "" });
    return out;
  }
  const isOpen = (key: string, start: boolean) => view.open.get(key) ?? start;

  const leaf = (kind: string, name: string, path: Path, depth: number, v: unknown, type: string, f?: SchemaRow): Row => {
    const editor = view.editing ? editorOf(kind) : "";
    return {
      key: keyOf(path), path, depth, name, type, text: textOf(kind, v), branch: false, open: false, editor,
      edit: v === undefined || v === null ? "" : String(v),
      options: editor === "enum" ? (f?.variants ?? []).map((x) => x.name) : undefined,
    };
  };

  const members = (schemaPath: string, v: unknown, path: Path, depth: number) => {
    for (const c of kids(block, schemaPath)) field(c, (v as Record<string, unknown> | undefined)?.[c.name], [...path, c.name], depth, c.path);
  };

  const field = (f: SchemaRow, v: unknown, path: Path, depth: number, schemaPath: string): void => {
    const key = keyOf(path);
    const name = path.length ? String(path[path.length - 1]) : "value";
    if (f.kind === "struct") {
      const open = isOpen(key, true);
      out.push({ key, path, depth, name, type: typeOf(block, f), text: "", branch: true, open, editor: "", edit: "", media: media(f.named) });
      if (open) members(schemaPath, v, path, depth + 1);
      return;
    }
    if (f.kind === "arr" || f.kind === "varr") {
      const items = listOf(v);
      const n = items.length;
      const e = elemOf(block, f);
      if (e?.kind === "u8") {
        out.push({ key, path, depth, name, type: typeOf(block, f), text: `${n} bytes`, branch: false, open: false, editor: "", edit: "" });
        return;
      }
      const open = isOpen(key, n <= WHOLE);
      out.push({ key, path, depth, name, type: typeOf(block, f), text: `${n} items`, branch: true, open, editor: "", edit: "" });
      if (!open || !e) return;
      const removable = view.editing && f.kind === "varr";
      for (let i = 0; i < Math.min(n, LISTED); i++) {
        const at = [...path, i];
        if (e.kind === "struct") {
          const k = keyOf(at);
          const elOpen = isOpen(k, n <= 1);
          out.push({ key: k, path: at, depth: depth + 1, name: `[${i}]`, type: typeOf(block, e), text: "", branch: true, open: elOpen, editor: "", edit: "", remove: removable, media: media(e.named) });
          if (elOpen) members(e.path, items[i], at, depth + 2);
        } else if (e.kind === "arr" || e.kind === "varr") {
          // a list of lists: each item a list of its own
          const first = out.length;
          field(e, items[i], at, depth + 1, e.path);
          out[first] = { ...out[first]!, name: `[${i}]`, remove: removable };
        } else {
          out.push({ ...leaf(e.kind, `[${i}]`, at, depth + 1, items[i], typeOf(block, e), e), remove: removable });
        }
      }
      if (n > LISTED) out.push({ key: `${key}+more`, path, depth: depth + 1, name: "", type: "", text: `${n - LISTED} more`, branch: false, open: false, editor: "", edit: "", more: n - LISTED });
      if (removable) out.push({ key: `${key}+add`, path, depth: depth + 1, name: "add", type: "", text: "", branch: false, open: false, editor: "", edit: "", add: true });
      return;
    }
    if (f.kind === "map") {
      const n = v && typeof v === "object" ? Object.keys(v).length : 0;
      out.push({ key, path, depth, name, type: "map", text: `${n} ${n === 1 ? "entry" : "entries"}`, branch: false, open: false, editor: "", edit: "" });
      return;
    }
    out.push(leaf(f.kind, name, path, depth, v, typeOf(block, f), f));
  };

  const root = bare(block);
  if (!root) members("", value, [], 0);
  else if (root.kind === "struct" || root.kind === "arr" || root.kind === "varr") {
    // a bare branch shows its children at the top, as the explorer does
    const before = out.length;
    field(root, value, [], 0, "");
    const lifted = out.splice(before).slice(1).map((r) => ({ ...r, depth: r.depth - 1 }));
    out.push(...lifted);
  } else field(root, value, [], 0, "");
  return out;
}

type Media = "VideoFrame" | "Image";

/** Where pictures sit in a schema: field paths with `[]` for each array on the way. */
function mediaFields(block: SchemaBlock): { segs: string[]; type: Media }[] {
  const root = media(block.name);
  if (root) return [{ segs: [], type: root }];
  const out: { segs: string[]; type: Media }[] = [];
  // a picture that is an array's element sits at a path ending [], as its element row's
  for (const f of block.fields) {
    const own = media(f.named);
    if (own) out.push({ segs: f.path ? f.path.split(".") : [], type: own });
  }
  return out;
}

/** Whether a schema holds a VideoFrame or Image anywhere, arrays included. */
export function hasMedia(block: SchemaBlock | null | undefined): boolean {
  return !!block && mediaFields(block).length > 0;
}

/** Every VideoFrame and Image in a value, with its path, wherever it sits. */
export function mediaIn(block: SchemaBlock | null | undefined, value: unknown): { key: string; path: Path; type: Media }[] {
  if (!block) return [];
  const out: { key: string; path: Path; type: Media }[] = [];
  for (const m of mediaFields(block)) {
    let paths: Path[] = [[]];
    for (const seg of m.segs) {
      // each [] after the name steps into every item of a list, a list of lists one more
      const name = seg.replace(/(\[\])+$/, "");
      paths = paths.map((p) => (name ? [...p, name] : p));
      for (let n = (seg.length - name.length) / 2; n > 0; n--)
        paths = paths.flatMap((at) => Array.from({ length: listOf(getAt(value, at)).length }, (_, i) => [...at, i]));
    }
    for (const path of paths) out.push({ key: keyOf(path), path, type: m.type });
  }
  return out;
}

/** A typed text read back into a value of kind, or why it is not one. */
export function parseEdit(kind: string, text: string, f?: Pick<SchemaRow, "cap" | "variants">): { ok: true; value: unknown } | { ok: false; why: string } {
  const t = text.trim();
  if (kind === "f32" || kind === "f64") {
    const low = t.toLowerCase();
    const n = low === "nan" ? NaN : low === "inf" || low === "infinity" ? Infinity : low === "-inf" || low === "-infinity" ? -Infinity : t === "" ? NaN : Number(t);
    return Number.isNaN(n) && low !== "nan" ? { ok: false, why: "not a number" } : { ok: true, value: n };
  }
  if (RANGE[kind]) {
    if (!/^-?\d+$/.test(t)) return { ok: false, why: "not a whole number" };
    const n = BigInt(t);
    const [lo, hi] = RANGE[kind]!;
    if (n < lo || n > hi) return { ok: false, why: `out of range for ${kind}` };
    return { ok: true, value: kind === "u64" || kind === "i64" ? n : Number(n) };
  }
  if (kind === "bool") return t === "true" || t === "false" ? { ok: true, value: t === "true" } : { ok: false, why: "true or false" };
  if (kind === "enum") return (f?.variants ?? []).some((v) => v.name === t) ? { ok: true, value: t } : { ok: false, why: "not an option" };
  if (kind === "string" || kind === "vstring") {
    if (f?.cap && new TextEncoder().encode(text).length > f.cap) return { ok: false, why: `longer than ${f.cap} bytes` };
    return { ok: true, value: text };
  }
  return { ok: false, why: "not editable" };
}

/** The schema row and kind of the value at path: a member's own row, an element its array's. */
export function fieldAt(block: SchemaBlock, path: Path): { kind: string; row?: SchemaRow } {
  const root = bare(block);
  let schemaPath = "";
  let row: SchemaRow | undefined = root;
  for (const seg of path) {
    // an index steps to the array's element row, a name to a member's
    schemaPath = typeof seg === "number" ? `${schemaPath}[]` : schemaPath ? `${schemaPath}.${seg}` : seg;
    row = block.fields.find((f) => f.path === schemaPath);
  }
  if (!row) return { kind: "" };
  return { kind: row.kind, row };
}

function zero(block: SchemaBlock, f: SchemaRow, schemaPath: string): unknown {
  switch (f.kind) {
    case "struct":
      return zeroMembers(block, schemaPath);
    case "arr":
    case "varr": {
      const n = f.kind === "arr" ? (f.count ?? 0) : 0;
      const e = elemOf(block, f);
      if (e && TYPED[e.kind]) return new TYPED[e.kind]!(n);
      return Array.from({ length: n }, () => (e ? zero(block, e, e.path) : 0));
    }
    case "string":
    case "vstring":
      return "";
    case "bool":
      return false;
    case "enum":
      return f.variants?.[0]?.name ?? 0;
    case "map":
      return {};
    case "u64":
    case "i64":
      return 0n;
    default:
      return 0;
  }
}

function zeroMembers(block: SchemaBlock, schemaPath: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of kids(block, schemaPath)) out[c.name] = zero(block, c, c.path);
  return out;
}

/** A value of the schema with every field at its zero, to edit before a send. */
export function templateOf(block: SchemaBlock | null | undefined): unknown {
  if (!block) return new Uint8Array(0);
  const root = bare(block);
  return root ? zero(block, root, "") : zeroMembers(block, "");
}

export function getAt(v: unknown, path: Path): unknown {
  return path.reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string | number, unknown>)[k]), v);
}

/** root with the value at path replaced, root itself when path is empty. Arrays and objects are changed in place. */
export function setAt(root: unknown, path: Path, value: unknown): unknown {
  if (!path.length) return value;
  const parent = getAt(root, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path[path.length - 1]!] = value;
  return root;
}

/** root with one more element at the end of the array at path. */
export function addElement(block: SchemaBlock, root: unknown, path: Path): unknown {
  const { row } = fieldAt(block, path);
  if (!row) return root;
  const list = getAt(root, path);
  const e = elemOf(block, row);
  const added = e ? zero(block, e, e.path) : 0;
  if (ArrayBuffer.isView(list)) {
    const typed = list as unknown as { length: number; constructor: new (n: number) => { set(a: ArrayLike<unknown>): void } };
    const grown = new typed.constructor(typed.length + 1);
    grown.set(list as unknown as ArrayLike<unknown>);
    return setAt(root, path, grown);
  }
  return setAt(root, path, [...(Array.isArray(list) ? list : []), added]);
}

/** root without the element at path. */
export function removeElement(root: unknown, path: Path): unknown {
  const at = path[path.length - 1] as number;
  const listPath = path.slice(0, -1);
  const list = getAt(root, listPath);
  if (ArrayBuffer.isView(list)) {
    const typed = list as unknown as { length: number; constructor: new (n: number) => { set(a: ArrayLike<unknown>, o?: number): void }; subarray(a: number, b?: number): ArrayLike<unknown> };
    const shrunk = new typed.constructor(typed.length - 1);
    shrunk.set(typed.subarray(0, at));
    shrunk.set(typed.subarray(at + 1), at);
    return setAt(root, listPath, shrunk);
  }
  return setAt(root, listPath, (Array.isArray(list) ? list : []).filter((_, i) => i !== at));
}

/** A fresh value with the user's edits put back: what they changed stays, the rest follows the mesh. */
export function keepEdits(next: unknown, draft: unknown, edited: Iterable<string>): unknown {
  let out = next;
  for (const key of edited) {
    const path = JSON.parse(key) as Path;
    const kept = getAt(draft, path);
    if (path.length && getAt(out, path.slice(0, -1)) == null) continue;
    out = setAt(out, path, kept);
  }
  return out;
}
