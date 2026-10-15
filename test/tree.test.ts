import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseGroups, parseNodes, parsePackages } from "../src/cli/parse.ts";
import { actionArgs, newArgs, validName } from "../src/views/workspaces/actions.ts";
import { buildTree } from "../src/views/workspaces/tree.ts";
import type { WorkspaceData } from "../src/workspaces/load.ts";
import { fixture } from "./helpers.ts";

function workspace(nodes: string): WorkspaceData {
  return {
    root: "C:/work/wsa",
    name: "wsa",
    packages: parsePackages(fixture("cli/ls-packages.json")),
    groups: parseGroups(fixture("cli/ls-groups.json")),
    listing: parseNodes(fixture(nodes)),
  };
}

describe("buildTree", () => {
  it("shows packages, nodes and groups of an idle workspace", () => {
    const [ws] = buildTree([workspace("cli/ls-nodes-idle.json")]);
    assert.equal(ws?.label, "wsa");
    assert.equal(ws?.running, false);
    assert.deepEqual(ws?.children.map((c) => [c.label, c.description]), [["Packages", "1"], ["Nodes", "2"], ["Groups", "1"]]);
    const nodes = ws?.children[1]?.children ?? [];
    assert.deepEqual(nodes.map((n) => [n.ref, n.running, n.description]), [
      ["wsa/listener", false, "python"],
      ["wsa/talker", false, "python"],
    ]);
  });

  it("marks running nodes and groups and puts them first", () => {
    const [ws] = buildTree([workspace("cli/ls-nodes-loose.json")]);
    assert.equal(ws?.running, true);
    assert.equal(ws?.description, "1 running");
    const nodes = ws?.children[1]?.children ?? [];
    assert.deepEqual(nodes.map((n) => [n.ref, n.running]), [["talker", true], ["wsa/listener", false]]);

    const [grouped] = buildTree([workspace("cli/ls-nodes-group.json")]);
    const group = grouped?.children.find((c) => c.label === "Groups")?.children[0];
    assert.equal(group?.running, true);
    assert.equal(group?.description, "running, The talker and the listener");
    assert.equal(grouped?.children[1]?.children[0]?.description, "running, wsa/WsaGroup");
  });

  it("gives every row an id that stays the same between builds", () => {
    const a = buildTree([workspace("cli/ls-nodes-idle.json")]);
    const b = buildTree([workspace("cli/ls-nodes-idle.json")]);
    const ids = (t: typeof a): string[] => t.flatMap((n) => [n.id, ...ids(n.children)]);
    assert.deepEqual(ids(a), ids(b));
    assert.equal(new Set(ids(a)).size, ids(a).length);
  });

  it("shows a workspace the CLI could not read as one row with the error", () => {
    const [ws] = buildTree([{ ...workspace("cli/ls-nodes-idle.json"), error: "node `bad` needs `run`" }]);
    assert.equal(ws?.error, true);
    assert.equal(ws?.description, "node `bad` needs `run`");
    assert.deepEqual(ws?.children, []);
  });

  it("keeps several workspaces apart", () => {
    const a = workspace("cli/ls-nodes-idle.json");
    const tree = buildTree([a, { ...a, root: "C:/work/wsb", name: "wsb" }]);
    assert.deepEqual(tree.map((w) => w.label), ["wsa", "wsb"]);
    assert.notEqual(tree[0]?.children[0]?.id, tree[1]?.children[0]?.id);
  });

  it("leaves out sections with nothing in them", () => {
    const [ws] = buildTree([{ ...workspace("cli/ls-nodes-idle.json"), groups: [] }]);
    assert.deepEqual(ws?.children.map((c) => c.label), ["Packages", "Nodes"]);
  });
});

describe("actionArgs", () => {
  it("builds a workspace or a package", () => {
    assert.deepEqual(actionArgs("build", { kind: "workspace", ref: "/ws" }), ["build"]);
    assert.deepEqual(actionArgs("build", { kind: "package", ref: "wsa" }), ["build", "wsa"]);
  });

  it("starts, stops and restarts nodes and groups", () => {
    assert.deepEqual(actionArgs("start", { kind: "node", ref: "wsa/talker" }), ["run", "node", "wsa/talker"]);
    assert.deepEqual(actionArgs("start", { kind: "group", ref: "wsa/WsaGroup" }), ["run", "wsa/WsaGroup"]);
    assert.deepEqual(actionArgs("stop", { kind: "node", ref: "talker" }), ["stop", "talker", "-y"]);
    assert.deepEqual(actionArgs("stop", { kind: "workspace", ref: "/ws" }), ["stop", "-y"]);
    assert.deepEqual(actionArgs("restart", { kind: "group", ref: "G" }), ["restart", "G"]);
    assert.deepEqual(actionArgs("restart", { kind: "workspace", ref: "/ws" }), ["restart"]);
  });

  it("refuses an action that does not fit the row", () => {
    assert.equal(actionArgs("start", { kind: "package", ref: "p" }), undefined);
    assert.equal(actionArgs("build", { kind: "node", ref: "n" }), undefined);
  });
});

describe("newArgs", () => {
  it("passes the language to workspaces and packages only", () => {
    assert.deepEqual(newArgs("workspace", "demo", "cpp"), ["new", "workspace", "demo", "--lang", "cpp", "-y"]);
    assert.deepEqual(newArgs("package", "cam", "csharp"), ["new", "package", "cam", "--lang", "csharp", "-y"]);
    assert.deepEqual(newArgs("node", "lidar"), ["new", "node", "lidar", "-y"]);
    assert.deepEqual(newArgs("group", "NavGroup"), ["new", "group", "NavGroup", "-y"]);
  });

  it("checks names", () => {
    assert.equal(validName("arm_controller"), undefined);
    assert.notEqual(validName("two words"), undefined);
    assert.notEqual(validName("../x"), undefined);
    assert.notEqual(validName(""), undefined);
  });
});
