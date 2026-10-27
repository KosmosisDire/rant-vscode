import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { openNode } from "rant-middleware";

import { blockOf, typeName } from "../src/views/mesh/table.ts";

// a node on loopback only, to compile schemas the way a peer's arrive
const node = await openNode(null, { domain: 197, multicastInterface: "127.0.0.1" });
after(() => node.close());

describe("blockOf", () => {
  it("spells paths, kinds and names the way the page reads them", () => {
    const s = node.schema("Rig { cam: Image, points: Float3[], tag: string<8>, note: string, mode: enum<u8> { Off, On } }");
    const rows = new Map(blockOf(s).fields.map((f) => [f.path, f]));
    assert.equal(rows.get("cam")?.named, "Image");
    assert.equal(rows.get("cam.format")?.kind, "enum");
    assert.deepEqual([rows.get("points[]")?.kind, rows.get("points[]")?.named], ["struct", "Float3"]);
    assert.equal(rows.get("points")?.kind, "varr");
    assert.equal(rows.get("points[].x")?.kind, "f32");
    assert.deepEqual([rows.get("tag")?.kind, rows.get("tag")?.cap], ["string", 8]);
    assert.equal(rows.get("note")?.kind, "vstring");
    assert.deepEqual(rows.get("mode")?.variants, [{ name: "Off", value: 0 }, { name: "On", value: 1 }]);
    assert.equal(blockOf(s).name, "Rig");
  });

  it("names a bare type by its kind", () => {
    assert.equal(typeName(node.schema("f64")), "f64");
    assert.equal(typeName(node.schema("Pose")), "Pose");
    assert.equal(typeName(null), "bytes");
    assert.equal(blockOf(node.schema("Float3[]")).fields.find((f) => f.name === "x")?.path, "[].x");
    // a list of lists: each element a row of its own
    const grid = new Map(blockOf(node.schema("Grid { rows: f32[3][] }")).fields.map((f) => [f.path, f.kind]));
    assert.deepEqual([grid.get("rows"), grid.get("rows[]"), grid.get("rows[][]")], ["varr", "arr", "f32"]);
  });
});
