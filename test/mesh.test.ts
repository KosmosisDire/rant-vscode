import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MeshEntity, Peer } from "rant-client";

import { bridgeSettings, meshDomain, rantHome } from "../src/bridge/settings.ts";
import { rttText, show, template } from "../src/views/mesh/format.ts";
import { buildMesh } from "../src/views/mesh/tree.ts";

describe("bridgeSettings", () => {
  it("builds the url from the port and bind", () => {
    const s = bridgeSettings("port: 7600\nbind: 127.0.0.1\npassphrase: ABCD-EFGH\n");
    assert.deepEqual(s, { url: "ws://127.0.0.1:7600", passphrase: "ABCD-EFGH" });
  });

  it("reaches a bridge bound to every interface through localhost", () => {
    assert.equal(bridgeSettings("bind: 0.0.0.0\n").url, "ws://127.0.0.1:7480");
  });

  it("takes the running bridge's url from the state file", () => {
    const s = bridgeSettings("port: 7480\n", "pid: 12\nurl: ws://127.0.0.1:7481\nversion: 0.1.0\n");
    assert.equal(s.url, "ws://127.0.0.1:7481");
  });

  it("reads an empty config as the defaults", () => {
    assert.deepEqual(bridgeSettings(""), { url: "ws://127.0.0.1:7480", passphrase: "" });
  });

  it("finds the folder through RANT_HOME", () => {
    assert.equal(rantHome({ RANT_HOME: "/srv/rant" }, "/home/u"), "/srv/rant");
    assert.match(rantHome({}, "/home/u"), /home[\\/]u[\\/]\.rant$/);
  });
});

describe("meshDomain", () => {
  it("prefers the setting, then RANT_DOMAIN, then 0", () => {
    assert.equal(meshDomain(150, { RANT_DOMAIN: "7" }), 150);
    assert.equal(meshDomain(null, { RANT_DOMAIN: "7" }), 7);
    assert.equal(meshDomain(undefined, {}), 0);
    assert.equal(meshDomain(null, { RANT_DOMAIN: "nope" }), 0);
  });
});

describe("show", () => {
  it("keeps 64 bit numbers, NaN and bytes readable", () => {
    const text = show({ stamp: 18000000000000000123n, value: NaN, data: new Uint8Array(500) });
    assert.deepEqual(JSON.parse(text), { stamp: "18000000000000000123", value: "NaN", data: "<500 bytes>" });
  });

  it("cuts long arrays short", () => {
    const v = JSON.parse(show(new Float32Array(40))) as unknown[];
    assert.equal(v.length, 33);
    assert.equal(v[32], "... 8 more");
  });
});

describe("template", () => {
  it("puts every field at its zero, nested structs included", () => {
    const block = {
      name: "Reading", hash: "", dsl: "",
      fields: [
        { path: "pose", name: "pose", kind: "struct" },
        { path: "pose.x", name: "x", kind: "f64" },
        { path: "label", name: "label", kind: "string" },
        { path: "mode", name: "mode", kind: "enum", variants: [{ name: "Idle", value: 0 }] },
        { path: "points", name: "points", kind: "varr", elem: "struct" },
        { path: "points[].z", name: "z", kind: "f64" },
        { path: "ok", name: "ok", kind: "bool" },
      ],
    };
    assert.deepEqual(template(block), { pose: { x: 0 }, label: "", mode: "Idle", points: [], ok: false });
  });

  it("gives a bare type its zero", () => {
    assert.equal(template({ name: "f64", hash: "", dsl: "", fields: [{ path: "", name: "", kind: "f64" }] }), 0);
    assert.equal(template(undefined), null);
  });
});

describe("rttText", () => {
  it("shows a tenth of a millisecond below 10 ms", () => {
    assert.equal(rttText(1234), "1.2 ms");
    assert.equal(rttText(25600), "26 ms");
    assert.equal(rttText(0), "");
  });
});

const rtt = (us: number) => ({ us, jitterUs: 0, samples: 1, atUs: 0 });
const peer = (id: number, name: string): Peer => ({ id, name, address: "10.0.0.2", active: true, lastHeardUs: 0, rtt: rtt(800), meshRtt: rtt(500), missed: 0 });
const entity = (kind: MeshEntity["kind"], name: string): MeshEntity => ({
  kind, name, provides: true, consumes: false, reliable: true, providers: 1, consumers: 2, generation: "0",
});

describe("buildMesh", () => {
  it("lists the nodes, then each kind that has entities, sorted by name", () => {
    const tree = buildMesh([peer(2, "robot"), peer(1, "arm")], [entity("topic", "odom"), entity("topic", "cmd"), entity("task", "dock")]);
    assert.deepEqual(tree.map((s) => s.label), ["Nodes", "Topics", "Tasks"]);
    const [nodes, topics] = tree;
    assert.ok(nodes?.kind === "section" && topics?.kind === "section");
    assert.deepEqual(nodes.children.map((c) => c.label), ["arm", "robot"]);
    assert.deepEqual(topics.children.map((c) => c.label), ["cmd", "odom"]);
  });

  it("leaves out Rant's own entities", () => {
    const tree = buildMesh([], [entity("topic", "@rant/log/info"), entity("function", "@rant/meta")]);
    assert.deepEqual(tree.map((s) => s.label), ["Nodes"]);
  });

  it("describes an entity by its type and its ends", () => {
    const [, topics] = buildMesh([], [entity("topic", "odom")]);
    assert.ok(topics?.kind === "section");
    const row = topics.children[0];
    assert.ok(row?.kind === "entity");
    assert.equal(row.description, "bytes, 1 pub, 2 sub");
  });

  it("shows a peer's round trip, and missed probes once there are two", () => {
    const [nodes] = buildMesh([peer(1, "arm"), { ...peer(2, "slow"), missed: 3 }], []);
    assert.ok(nodes?.kind === "section");
    assert.deepEqual(nodes.children.map((c) => (c.kind === "peer" ? c.description : "")), ["0.8 ms", "missed 3"]);
  });
});
