import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";

import { parseGroups, parseNodes, parsePackages, parseSource, parseUses } from "../src/cli/parse.ts";
import { fixture } from "./helpers.ts";

describe("parsePackages", () => {
  it("reads rant ls packages", () => {
    assert.deepEqual(parsePackages(fixture("cli/ls-packages.json")), [
      {
        name: "wsa",
        kinds: ["python"],
        folder: "C:/work/wsa",
        files: ["C:/work/wsa/pyproject.toml", "C:/work/wsa/package.rant"],
        rant: "0.0.22",
      },
    ]);
  });

  it("refuses another shape", () => {
    assert.throws(() => parsePackages("{}"), /ls packages/);
    assert.throws(() => parsePackages("not json"), /ls packages/);
  });
});

describe("parseUses", () => {
  it("reads rant lib, a missing version as null", () => {
    const uses = parseUses(fixture("cli/lib.json"));
    assert.deepEqual(uses.map((u) => [u.how, u.version]), [["pyproject", null], ["venv", "0.0.22"], ["CPM", "0.0.21"], ["venv", null]]);
    assert.equal(uses[2]?.file, "C:/work/wsa/cam/CMakeLists.txt");
    assert.throws(() => parseUses("{}"), /rant lib/);
  });
});

describe("parseGroups", () => {
  it("reads rant ls groups", () => {
    const [g] = parseGroups(fixture("cli/ls-groups.json"));
    assert.equal(g?.name, "wsa/WsaGroup");
    assert.equal(g?.description, "The talker and the listener");
    assert.deepEqual(g?.nodes, [
      { name: "talker", type: "wsa/talker" },
      { name: "listener", type: "wsa/listener" },
    ]);
    assert.deepEqual(g?.includes, []);
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
      l.nodes.map((n) => [n.name, n.type, n.running, n.groups]),
      [
        ["talker", "wsa/talker", true, ["wsa/WsaGroup"]],
        ["listener", "wsa/listener", true, ["wsa/WsaGroup"]],
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

  it("keeps the group whose own block made a node, inside the run that started it", () => {
    const raw = JSON.stringify({
      domain: 0,
      groups: [{ group: "DriveGroup", nodes: [{ name: "motors", type: "p/motors", domain: 0, group: "BaseGroup" }] }],
      nodes: [{ name: "solo", type: "p/solo", domain: 0 }],
    });
    const l = parseNodes(raw);
    assert.deepEqual(l.nodes.map((n) => [n.name, n.groups, n.group]), [
      ["motors", ["DriveGroup"], "BaseGroup"],
      ["solo", [], undefined],
    ]);
  });

  it("names a group run twice once", () => {
    const raw = JSON.stringify({
      groups: [
        { group: "Nav target=red", nodes: [{ name: "a", type: "p/a", domain: 3 }] },
        { group: "Nav target=blue", nodes: [{ name: "b", type: "p/b", domain: 3 }] },
      ],
      nodes: [],
      domain: 3,
    });
    const l = parseNodes(raw);
    assert.equal(l.domain, 3);
    assert.deepEqual(l.nodes.map((n) => n.domain), [3, 3]);
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

  it("never opens a built program, only its source", () => {
    const native = JSON.stringify([{ node: "cam/cam", kind: "native", file: "build/cam.exe", source: "src/cam.cpp", cwd: "cam" }]);
    assert.deepEqual(parseSource(native, root), { file: path.resolve(root, "src/cam.cpp") });
    assert.equal(parseSource(JSON.stringify([{ node: "cam/cam", kind: "native", file: "build/cam.exe", cwd: "cam" }]), root), undefined);
  });

  it("knows nothing of a node the mesh shows alone", () => {
    assert.equal(parseSource(JSON.stringify([{ node: "x", from: "y" }]), root), undefined);
  });
});
