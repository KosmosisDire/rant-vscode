// Values between the extension and its pages: JSON has no 64 bit integers, NaN or typed arrays,
// so those travel as tagged objects and come back as they were.

type Tagged = { $rant: "int"; v: string } | { $rant: "num"; v: string } | { $rant: "typed"; t: string; b: Uint8Array };

const TYPED: Record<string, new (b: ArrayBuffer) => ArrayBufferView> = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array,
};

/** A value made safe for a webview message. */
export function pack(v: unknown): unknown {
  if (typeof v === "bigint") return { $rant: "int", v: v.toString() } satisfies Tagged;
  if (typeof v === "number" && !Number.isFinite(v)) return { $rant: "num", v: String(v) } satisfies Tagged;
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    // only plain bytes cross: VS Code carries a Uint8Array whole, the other kinds not everywhere
    return { $rant: "typed", t: v.constructor.name, b: new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) } satisfies Tagged;
  }
  if (Array.isArray(v)) return v.map(pack);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (typeof x !== "function") out[k] = pack(x);
    return out;
  }
  return v;
}

/** A value as pack had it. */
export function unpack(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unpack);
  if (!v || typeof v !== "object") return v;
  const t = v as Partial<Tagged> & Record<string, unknown>;
  if (t.$rant === "int") return BigInt(t.v as string);
  if (t.$rant === "num") return Number(t.v);
  if (t.$rant === "typed") {
    const bytes = t.b as Uint8Array;
    const Kind = TYPED[t.t as string] ?? Uint8Array;
    return new Kind(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = unpack(x);
  return out;
}
