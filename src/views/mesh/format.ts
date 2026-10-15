import type { SchemaBlock } from "rant-client";

const MAX_ITEMS = 32;

function plain(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (ArrayBuffer.isView(v)) {
    const items = Array.from(v as unknown as ArrayLike<number | bigint>);
    const shown = items.slice(0, MAX_ITEMS).map(plain);
    return items.length > MAX_ITEMS ? [...shown, `... ${items.length - MAX_ITEMS} more`] : shown;
  }
  if (Array.isArray(v)) {
    const shown = v.slice(0, MAX_ITEMS).map(plain);
    return v.length > MAX_ITEMS ? [...shown, `... ${v.length - MAX_ITEMS} more`] : shown;
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (typeof x !== "function") out[k] = plain(x);
    return out;
  }
  return v;
}

/** A value as readable JSON: 64 bit numbers as text, bytes as a size, long arrays cut short. */
export function show(value: unknown): string {
  return JSON.stringify(plain(value), null, 2) ?? "null";
}

function blank(kind: string, variants: { name: string }[] | undefined): unknown {
  switch (kind) {
    case "bool":
      return false;
    case "string":
    case "vstring":
      return "";
    case "enum":
      return variants?.[0]?.name ?? 0;
    case "arr":
    case "varr":
      return [];
    case "map":
    case "struct":
      return {};
    default:
      return 0;
  }
}

/** A value of the schema with every field at its zero, to edit before a send. */
export function template(block: SchemaBlock | undefined): unknown {
  if (!block || !block.fields.length) return null;
  const first = block.fields[0]!;
  if (block.fields.length === 1 && !first.name) return blank(first.kind, first.variants);
  const root: Record<string, unknown> = {};
  for (const row of block.fields) {
    const segs = row.path.split(".");
    // members of a struct array only describe its elements, the array starts empty
    if (segs.slice(0, -1).some((s) => s.endsWith("[]"))) continue;
    let at = root;
    for (const s of segs.slice(0, -1)) at = (at[s] ??= {}) as Record<string, unknown>;
    at[segs[segs.length - 1]!] = blank(row.kind, row.variants);
  }
  return root;
}

/** A round trip in microseconds as a short text. */
export function rttText(us: number): string {
  if (us <= 0) return "";
  return us < 10000 ? `${(us / 1000).toFixed(1)} ms` : `${Math.round(us / 1000)} ms`;
}
