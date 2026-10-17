import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CompiledSchema, Entity, Peer } from "rant-middleware";

import { meshDomain } from "../src/mesh/settings.ts";
import type { NodeEntry, NodeListing } from "../src/cli/parse.ts";
import { buildMesh, meshCounts, nest, rttText } from "../src/views/mesh/tree.ts";
import type { MeshItem } from "../src/views/mesh/tree.ts";

describe("meshDomain", () => {
  it("prefers the setting, then the workspace, then RANT_DOMAIN, then 0", () => {
    assert.equal(meshDomain(150, 2, { RANT_DOMAIN: "7" }), 150);
    assert.equal(meshDomain(null, 2, { RANT_DOMAIN: "7" }), 2);
    assert.equal(meshDomain(null, 0, { RANT_DOMAIN: "7" }), 0);
    assert.equal(meshDomain(null, undefined, { RANT_DOMAIN: "7" }), 7);
    assert.equal(meshDomain(undefined, undefined, {}), 0);
    assert.equal(meshDomain(null, undefined, { RANT_DOMAIN: "nope" }), 0);
  });
});

describe("rttText", () => {
  it("shows a tenth of a millisecond below 10 ms", () => {
    assert.equal(rttText(1234), "1.2 ms");
    assert.equal(rttText(25600), "26 ms");
    assert.equal(rttText(0), "");
  });
});

const peer = (id: number, name: string): Peer => ({
  id, uuid: "", name, address: "10.0.0.2", active: true, lastHeardUs: 0, epoch: 0, catchingUp: false, fragmentSize: 1350,
  rttUs: 800, rttJitterUs: 0, rttMinUs: 800, rttSamples: 1,
});
const entity = (kind: Entity["kind"], name: string): Entity => ({
  kind, name, hash: 0, provides: true, consumes: false, reliable: true, writable: false, forceable: false, cancellable: false,
  exclusive: false, multi: false, incomplete: false, conflict: false, providers: 1, consumers: 2, provider: 0, from: "",
  schema: null, schemaHash: 0n, rspSchema: null, rspSchemaHash: 0n, progressSchema: null, progressSchemaHash: 0n, generation: 0n,
});
const listing = (groups: Record<string, string[]>, loose: string[] = [], domain = 0): NodeListing => {
  const nodes = new Map<string, NodeEntry>();
  for (const [g, names] of Object.entries(groups))
    for (const n of names) {
      const e: NodeEntry = nodes.get(n) ?? { name: n, type: `p/${n}`, running: true, groups: [], domain };
      e.groups.push(g);
      nodes.set(n, e);
    }
  for (const n of loose) nodes.set(n, { name: n, type: `p/${n}`, running: true, groups: [], domain });
  return { domain, nodes: [...nodes.values()], runningGroups: Object.keys(groups) };
};
// a tree as labels: a row with children as [label, children], a leaf as its label
const labels = (items: MeshItem[]): unknown[] =>
  items.map((i) => ("children" in i ? [i.label, labels(i.children)] : i.label));

describe("buildMesh", () => {
  it("puts nodes under each running group, a shared node under both, then the rest", () => {
    const ws = { root: "C:/ws", name: "ws", listing: listing({ NavGroup: ["lidar", "odom", "planner"], PickGroup: ["lidar", "odom", "arm"] }, ["camera"]) };
    const peers = ["lidar", "odom", "planner", "arm", "camera", "gp12"].map((n, i) => peer(i + 1, n));
    const [nodes] = buildMesh(peers, [], [ws], 0);
    assert.deepEqual(labels([nodes!]), [
      ["Nodes", [["NavGroup", ["lidar", "odom", "planner"]], ["PickGroup", ["arm", "lidar", "odom"]], "camera", "gp12"]],
    ]);
  });

  it("lets only what a workspace started be stopped or restarted, and shows one still joining", () => {
    const ws = { root: "C:/ws", name: "ws", listing: listing({ NavGroup: ["lidar", "planner"] }) };
    const [nodes] = buildMesh([peer(1, "lidar"), peer(2, "gp12")], [], [ws], 0);
    assert.ok(nodes?.kind === "section");
    const [group, other] = nodes.children;
    assert.ok(group?.kind === "group" && other?.kind === "node");
    assert.deepEqual([group.root, group.ref], ["C:/ws", "NavGroup"]);
    const [lidar, planner] = group.children;
    assert.ok(lidar?.kind === "node" && planner?.kind === "node");
    assert.deepEqual([lidar.root, lidar.state, lidar.description], ["C:/ws", "up", "0.8 ms"]);
    assert.deepEqual([planner.state, planner.description], ["joining", "joining"]);
    assert.deepEqual([other.label, other.root], ["gp12", undefined]);
  });

  it("nests a group a run includes under that run, with its own nodes", () => {
    const l = listing({ DriveGroup: ["ft", "motors", "nac"] });
    for (const n of l.nodes) n.group = n.name === "ft" ? "DriveGroup" : "BaseGroup";
    const ws = { root: "C:/ws", name: "ws", listing: l };
    const [nodes] = buildMesh(["ft", "motors", "nac"].map((n, i) => peer(i + 1, n)), [], [ws], 0);
    assert.deepEqual(labels([nodes!]), [["Nodes", [["DriveGroup", ["ft", ["BaseGroup", ["motors", "nac"]]]]]]]);
    const inner = nodes?.kind === "section" ? nodes.children[0] : undefined;
    const base = inner?.kind === "group" ? inner.children[1] : undefined;
    assert.deepEqual(base?.kind === "group" ? [base.root, base.ref] : [], ["C:/ws", "BaseGroup"]);
  });

  it("leaves out what a workspace started on another domain", () => {
    const ws = { root: "C:/ws", name: "ws", listing: listing({ NavGroup: ["lidar"] }, ["camera"], 2) };
    const [nodes] = buildMesh([peer(1, "gp12")], [], [ws], 0);
    assert.deepEqual(labels([nodes!]), [["Nodes", ["gp12"]]]);
    const [same] = buildMesh([peer(1, "lidar")], [], [ws], 2);
    assert.deepEqual(labels([same!]), [["Nodes", [["NavGroup", ["lidar"]], "camera"]]]);
  });

  it("hides tooling nodes and keeps nodes that share a name apart", () => {
    const [nodes] = buildMesh([peer(1, "arm"), peer(2, "@rant/cli"), peer(3, "vscode"), peer(4, "explorer"), peer(5, "arm")], [], [], 0);
    assert.ok(nodes?.kind === "section");
    assert.deepEqual(nodes.children.map((c) => c.id), ["peer/1", "peer/5"]);
  });

  it("names a bare type by its kind", () => {
    const bare = { ...entity("variable", "delay"), schema: { name: "", fields: [{ name: "", kind: "f64" }] } as unknown as CompiledSchema };
    const [, entities] = buildMesh([], [bare], [], 0);
    assert.ok(entities?.kind === "section" && entities.children[0]?.kind === "entity");
    assert.equal(entities.children[0].description, "f64, 2 remote");
  });

  it("shows no round trip before one is measured", () => {
    const [nodes] = buildMesh([{ ...peer(1, "arm"), rttUs: 292, rttSamples: 0 }], [], [], 0);
    assert.ok(nodes?.kind === "section");
    assert.equal(nodes.children[0]?.kind === "node" ? nodes.children[0].description : "?", "");
  });

  it("shows every kind of entity in one tree and leaves out Rant's own", () => {
    const tree = buildMesh([], [entity("topic", "cage/gp12/joints"), entity("variable", "cage/gp12/isHome"), entity("topic", "@rant/log/info")], [], 0);
    assert.deepEqual(labels(tree), [["Nodes", []], ["Entities", [["cage/", [["gp12/", ["isHome", "joints"]]]]]]]);
  });
});

describe("meshCounts", () => {
  it("counts every publisher and subscriber of a node's own entity, not just the node's side", () => {
    const own = { ...entity("topic", "Pose"), providers: 1, consumers: 0 };
    const mesh = [{ ...entity("topic", "Pose"), providers: 1, consumers: 2 }, entity("variable", "Pose")];
    const lonely = entity("task", "home");
    assert.deepEqual(
      meshCounts([own, lonely], mesh).map((e) => [e.kind, e.name, e.consumers]),
      [["topic", "Pose", 2], ["task", "home", 2]],
    );
  });
});

describe("nest", () => {
  it("splits names on slashes one level at a time, folders first", () => {
    const tree = nest(
      [entity("variable", "cage/gp12/var/named/180PICK"), entity("variable", "cage/gp12/isHome"), entity("variable", "solo")],
      "entities",
    );
    assert.deepEqual(labels(tree), [["cage/", [["gp12/", [["var/", [["named/", ["180PICK"]]]], "isHome"]]]], "solo"]);
  });

  it("keeps ids apart between scopes and stable between builds", () => {
    const ids = (items: MeshItem[]): string[] => items.flatMap((i) => [i.id, ...("children" in i ? ids(i.children) : [])]);
    const list = [entity("topic", "a/b/c"), entity("topic", "a/d")];
    assert.deepEqual(ids(nest(list, "entities")), ids(nest(list, "entities")));
    assert.equal(new Set([...ids(nest(list, "entities")), ...ids(nest(list, "peer/1"))]).size, 8);
  });
});
