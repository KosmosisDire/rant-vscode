import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";

import { parseGroups, parseNodes, parsePackages, parseSource } from "../src/cli/parse.ts";
import { fixture } from "./helpers.ts";

describe("parsePackages", () => {
  it("reads rant ls packages", () => {
    assert.deepEqual(parsePackages(fixture("cli/ls-packages.json")), [
      { name: "wsa", kinds: ["python"], folder: "C:/work/wsa", rant: "0.0.22" },
    ]);
  });

  it("refuses another shape", () => {
    assert.throws(() => parsePackages("{}"), /ls packages/);
    assert.throws(() => parsePackages("not json"), /ls packages/);
  });
});

describe("parseGroups", () => {
  it("reads rant ls groups", () => {
    const [g] = parseGroups(fixture("cli/ls-groups.json"));
    assert.equal(g?.name, "wsa/WsaGroup");
    assert.equal(g?.description, "The talker and the listener");
  });
});

describe("parseNodes", () => {
  it("lists nodes that could start", () => {
    const l = parseNodes(fixture("cli/ls-nodes-idle.json"));
    assert.deepEqual(l.runningGroups, []);
    assert.deepEqual(
      l.nodes.map((n) => [n.name, n.running, n.kind]),
      [
        ["wsa/listener", false, "python"],
        ["wsa/talker", false, "python"],
      ],
    );
  });

  it("puts a running group's nodes under the group", () => {
    const l = parseNodes(fixture("cli/ls-nodes-group.json"));
    assert.deepEqual(l.runningGroups, ["wsa/WsaGroup"]);
    assert.deepEqual(
      l.nodes.map((n) => [n.name, n.running, n.groups]),
      [
        ["talker", true, ["wsa/WsaGroup"]],
        ["listener", true, ["wsa/WsaGroup"]],
      ],
    );
  });

  it("keeps a running node outside any group, and what could still start", () => {
    const l = parseNodes(fixture("cli/ls-nodes-loose.json"));
    assert.deepEqual(l.runningGroups, []);
    assert.deepEqual(
      l.nodes.map((n) => [n.name, n.running, n.groups]),
      [
        ["talker", true, []],
        ["wsa/listener", false, []],
      ],
    );
  });

  it("reads a declared node, which has no path", () => {
    const l = parseNodes(fixture("cli/ls-nodes-declared.json"));
    assert.deepEqual(l.nodes.map((n) => [n.name, n.kind]), [["driver/tool", "declared"]]);
  });

  it("names a group run twice once", () => {
    const raw = JSON.stringify({
      groups: [
        { group: "Nav target=red", nodes: [{ name: "a" }] },
        { group: "Nav target=blue", nodes: [{ name: "b" }] },
      ],
      nodes: [],
    });
    const l = parseNodes(raw);
    assert.deepEqual(l.runningGroups, ["Nav"]);
    assert.deepEqual(l.nodes.map((n) => n.groups), [["Nav"], ["Nav"]]);
  });
});

describe("parseSource", () => {
  const root = path.resolve("/ws");

  it("resolves the file of an idle node against the workspace", () => {
    assert.deepEqual(parseSource(fixture("cli/info-node-idle.json"), root), { file: path.resolve(root, "src/talker.py") });
  });

  it("finds the file behind a running node", () => {
    assert.deepEqual(parseSource(fixture("cli/info-node-running.json"), root), { file: path.resolve(root, "src/talker.py") });
  });

  it("points a declared node at its package.rant", () => {
    assert.deepEqual(parseSource(fixture("cli/info-node-declared.json"), root), {
      file: path.resolve(root, "pkgs/driver/package.rant"),
      find: 'node "tool"',
    });
  });

  it("knows nothing of a node the mesh shows alone", () => {
    assert.equal(parseSource(JSON.stringify([{ node: "x", from: "y" }]), root), undefined);
  });
});
