import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SchemaBlock } from "rant-client";

import { pack, unpack } from "../src/views/mesh/pack.ts";
import { addElement, hasMedia, keepEdits, keyOf, mediaIn, parseEdit, removeElement, tableRows, templateOf } from "../src/views/mesh/table.ts";

// a block as the bridge sends it: the field rows depth first, struct array members as `points[].z`
const Reading: SchemaBlock = {
  name: "Reading", hash: "", dsl: "",
  fields: [
    { path: "stamp", name: "stamp", kind: "u64" },
    { path: "value", name: "value", kind: "f64" },
    { path: "label", name: "label", kind: "string", cap: 16 },
    { path: "mode", name: "mode", kind: "enum", named: "Mode", variants: [{ name: "Idle", value: 0 }, { name: "Run", value: 1 }] },
    { path: "pose", name: "pose", kind: "struct", named: "Double2" },
    { path: "pose.x", name: "x", kind: "f64" },
    { path: "pose.y", name: "y", kind: "f64" },
    { path: "points", name: "points", kind: "varr", elem: "struct", elemNamed: "Float3" },
    { path: "points[].z", name: "z", kind: "f32" },
    { path: "samples", name: "samples", kind: "varr", elem: "f32" },
    { path: "raw", name: "raw", kind: "varr", elem: "u8" },
    { path: "on", name: "on", kind: "bool" },
  ],
};
const value = () => ({
  stamp: 18000000000000000123n, value: 1.23456, label: "", mode: "Run", pose: { x: 1, y: 2 },
  points: [{ z: 3 }, { z: 4 }], samples: new Float32Array(20), raw: new Uint8Array(500), on: true,
});
const view = (editing = false) => ({ open: new Map<string, boolean>(), editing });
const cells = (rows: ReturnType<typeof tableRows>) => rows.map((r) => [" ".repeat(r.depth) + r.name, r.type, r.text]);

describe("tableRows", () => {
  it("shows a value the way the explorer does", () => {
    assert.deepEqual(cells(tableRows(Reading, value(), view())), [
      ["stamp", "u64", "18000000000000000123"],
      ["value", "f64", "1.235"],
      ["label", "string<16>", "empty"],
      ["mode", "Mode", "Run"],
      ["pose", "Double2", ""],
      [" x", "f64", "1.000"],
      [" y", "f64", "2.000"],
      ["points", "Float3[]", "2 items"],
      [" [0]", "Float3", ""],
      [" [1]", "Float3", ""],
      ["samples", "f32[]", "20 items"],
      ["raw", "u8[]", "500 bytes"],
      ["on", "bool", "true"],
    ]);
  });

  it("opens what the user opened, closes what they closed", () => {
    const v = view();
    v.open.set(keyOf(["points", 0]), true);
    v.open.set(keyOf(["pose"]), false);
    const names = tableRows(Reading, value(), v).map((r) => r.name);
    assert.ok(names.includes("z") && !names.includes("x"));
  });

  it("gives each editable leaf an editor, and arrays remove and add rows while editing", () => {
    const rows = tableRows(Reading, value(), view(true));
    const by = (name: string) => rows.find((r) => r.name === name)!;
    assert.equal(by("stamp").editor, "text");
    assert.equal(by("stamp").edit, "18000000000000000123");
    assert.equal(by("value").edit, "1.23456");
    assert.deepEqual([by("mode").editor, by("mode").options], ["enum", ["Idle", "Run"]]);
    assert.equal(by("on").editor, "bool");
    assert.equal(by("raw").editor, "");
    assert.ok(by("[0]").remove);
    assert.equal(rows.filter((r) => r.add).length, 1);
  });

  it("lifts the children of a bare array to the top", () => {
    const bare: SchemaBlock = { name: "", hash: "", dsl: "f64[]", fields: [{ path: "", name: "", kind: "varr", elem: "f64" }] };
    assert.deepEqual(cells(tableRows(bare, new Float64Array([1, 2]), view())), [["[0]", "f64", "1.000"], ["[1]", "f64", "2.000"]]);
  });

  it("shows an untyped value as its size", () => {
    assert.deepEqual(cells(tableRows(null, new Uint8Array(3), view())), [["data", "bytes", "3 bytes"]]);
  });
});

describe("parseEdit", () => {
  it("reads whole numbers in range, 64 bit ones as bigint", () => {
    assert.deepEqual(parseEdit("u8", "255"), { ok: true, value: 255 });
    assert.equal(parseEdit("u8", "256").ok, false);
    assert.equal(parseEdit("i32", "1.5").ok, false);
    assert.deepEqual(parseEdit("u64", "18446744073709551615"), { ok: true, value: 18446744073709551615n });
  });

  it("reads floats with NaN and infinities", () => {
    assert.deepEqual(parseEdit("f64", "2.5"), { ok: true, value: 2.5 });
    assert.ok(Number.isNaN((parseEdit("f32", "nan") as { value: number }).value));
    assert.deepEqual(parseEdit("f64", "-inf"), { ok: true, value: -Infinity });
    assert.equal(parseEdit("f64", "abc").ok, false);
  });

  it("checks options and string length", () => {
    assert.deepEqual(parseEdit("enum", "Run", { variants: [{ name: "Run", value: 1 }] }), { ok: true, value: "Run" });
    assert.equal(parseEdit("enum", "Walk", { variants: [{ name: "Run", value: 1 }] }).ok, false);
    assert.equal(parseEdit("string", "x".repeat(17), { cap: 16 }).ok, false);
  });
});

describe("templateOf", () => {
  it("puts every field at its zero, of the right kind", () => {
    const t = templateOf(Reading) as ReturnType<typeof value>;
    assert.equal(t.stamp, 0n);
    assert.equal(t.mode, "Idle");
    assert.deepEqual(t.pose, { x: 0, y: 0 });
    assert.deepEqual(t.points, []);
    assert.ok(t.samples instanceof Float32Array && t.samples.length === 0);
    const fixed: SchemaBlock = { name: "M", hash: "", dsl: "", fields: [{ path: "m", name: "m", kind: "arr", elem: "f32", count: 9 }] };
    assert.equal((templateOf(fixed) as { m: Float32Array }).m.length, 9);
  });
});

describe("editing arrays", () => {
  it("adds and removes elements, typed arrays keeping their kind", () => {
    let v: unknown = value();
    v = addElement(Reading, v, ["samples"]);
    v = addElement(Reading, v, ["points"]);
    const after = v as ReturnType<typeof value>;
    assert.ok(after.samples instanceof Float32Array && after.samples.length === 21);
    assert.deepEqual(after.points[2], { z: 0 });
    v = removeElement(v, ["points", 0]);
    v = removeElement(v, ["samples", 0]);
    assert.deepEqual((v as ReturnType<typeof value>).points, [{ z: 4 }, { z: 0 }]);
    assert.equal((v as ReturnType<typeof value>).samples.length, 20);
  });

  it("keeps the user's edits over a fresh value", () => {
    const draft = { ...value(), label: "mine" };
    const next = { ...value(), value: 9 };
    const merged = keepEdits(next, draft, [keyOf(["label"])]) as ReturnType<typeof value>;
    assert.deepEqual([merged.label, merged.value], ["mine", 9]);
  });
});

describe("mediaIn", () => {
  it("finds a picture at the root", () => {
    const frame: SchemaBlock = { name: "VideoFrame", hash: "", dsl: "", fields: [] };
    assert.deepEqual(mediaIn(frame, {}).map((m) => m.path), [[]]);
    assert.ok(hasMedia(frame));
  });

  it("finds pictures in any field, in arrays too", () => {
    const rig: SchemaBlock = {
      name: "Rig", hash: "", dsl: "",
      fields: [
        { path: "front", name: "front", kind: "struct", named: "VideoFrame" },
        { path: "shots", name: "shots", kind: "varr", elem: "struct", elemNamed: "Image" },
        { path: "cams", name: "cams", kind: "varr", elem: "struct", elemNamed: "Cam" },
        { path: "cams[].frame", name: "frame", kind: "struct", named: "VideoFrame" },
        { path: "speed", name: "speed", kind: "f64" },
      ],
    };
    const v = { front: {}, shots: [{}, {}], cams: [{ frame: {} }], speed: 1 };
    assert.deepEqual(mediaIn(rig, v).map((m) => [m.path, m.type]), [
      [["front"], "VideoFrame"],
      [["shots", 0], "Image"],
      [["shots", 1], "Image"],
      [["cams", 0, "frame"], "VideoFrame"],
    ]);
    assert.equal(hasMedia({ name: "Plain", hash: "", dsl: "", fields: [{ path: "x", name: "x", kind: "f64" }] }), false);
  });
});

describe("pack", () => {
  it("brings back what JSON cannot carry", () => {
    const v = { a: 2n ** 63n, b: NaN, c: -Infinity, d: new BigInt64Array([-1n]), e: [new Float32Array([1.5]), { f: new Uint8Array([7]) }] };
    const back = unpack(JSON.parse(JSON.stringify(pack(v), (_k, x: unknown) => (x instanceof Uint8Array ? { u8: [...x] } : x), 0), (_k, x: { u8?: number[] }) => (x && x.u8 ? new Uint8Array(x.u8) : x))) as typeof v;
    assert.equal(back.a, 2n ** 63n);
    assert.ok(Number.isNaN(back.b));
    assert.equal(back.c, -Infinity);
    assert.ok(back.d instanceof BigInt64Array && back.d[0] === -1n);
    assert.ok(back.e[0] instanceof Float32Array && (back.e[0] as Float32Array)[0] === 1.5);
    assert.deepEqual((back.e[1] as { f: Uint8Array }).f, new Uint8Array([7]));
  });
});
