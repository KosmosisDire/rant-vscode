import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseGroups, parseNodes, parsePackages, parseUses } from "../src/cli/parse.ts";
import { actionArgs, newArgs, validName } from "../src/views/workspaces/actions.ts";
import { buildTree } from "../src/views/workspaces/tree.ts";
import type { TreeNode } from "../src/views/workspaces/tree.ts";
import type { WorkspaceData } from "../src/workspaces/load.ts";
import { fixture } from "./helpers.ts";

function workspace(nodes: string): WorkspaceData {
  return {
    root: "C:/work/wsa",
    name: "wsa",
    packages: parsePackages(fixture("cli/ls-packages.json")),
    groups: parseGroups(fixture("cli/ls-groups.json")),
    uses: parseUses(fixture("cli/lib.json")),
    listing: parseNodes(fixture(nodes)),
  };
}

const sectionOf = (ws: TreeNode | undefined, label: string): TreeNode[] => ws?.children.find((c) => c.label === label)?.children ?? [];

describe("buildTree", () => {
  it("shows packages, nodes and groups of an idle workspace", () => {
    const [ws] = buildTree([workspace("cli/ls-nodes-idle.json")]);
    assert.equal(ws?.label, "wsa");
    assert.equal(ws?.running, false);
    assert.deepEqual(ws?.children.map((c) => [c.label, c.description]), [
      ["Packages", "1"],
      ["Build systems", "4"],
      ["Nodes", "2"],
      ["Groups", "1"],
    ]);
    const nodes = sectionOf(ws, "Nodes");
    assert.deepEqual(nodes.map((n) => [n.ref, n.running, n.description]), [
      ["wsa/listener", false, "python"],
      ["wsa/talker", false, "python"],
    ]);
  });

  it("marks running nodes and groups and puts them first", () => {
    const [ws] = buildTree([workspace("cli/ls-nodes-loose.json")]);
    assert.equal(ws?.running, true);
    assert.equal(ws?.description, "1 running");
    const nodes = sectionOf(ws, "Nodes");
    assert.deepEqual(nodes.map((n) => [n.ref, n.running]), [["talker", true], ["wsa/listener", false]]);

    const [grouped] = buildTree([workspace("cli/ls-nodes-group.json")]);
    const group = grouped?.children.find((c) => c.label === "Groups")?.children[0];
    assert.equal(group?.running, true);
    assert.equal(group?.description, "running, The talker and the listener");
    assert.equal(sectionOf(grouped, "Nodes")[0]?.description, "running, wsa/WsaGroup");
  });

  it("opens a package's build file and a group's file on a click, never a node's", () => {
    const [ws] = buildTree([workspace("cli/ls-nodes-idle.json")]);
    assert.equal(sectionOf(ws, "Packages")[0]?.open, "C:/work/wsa/pyproject.toml");
    assert.equal(sectionOf(ws, "Groups")[0]?.open, sectionOf(ws, "Groups")[0]?.path);
    assert.equal(sectionOf(ws, "Nodes")[0]?.open, undefined);
  });

  it("lists build systems by file with their Rant, a venv never opened", () => {
    const [ws] = buildTree([workspace("cli/ls-nodes-idle.json")]);
    const rows = sectionOf(ws, "Build systems");
    assert.deepEqual(rows.map((r) => [r.label, r.ref, r.description, r.hasRant, r.open !== undefined]), [
      [".venv", ".", "venv, Rant 0.0.22", true, false],
      ["cam/CMakeLists.txt", "cam", "CPM, Rant 0.0.21", true, true],
      ["pyproject.toml", ".", "pyproject, Rant unpinned", true, true],
      ["tools/env", "tools", "venv, no Rant", false, false],
    ]);
  });

  it("lists a package build file without Rant so Rant can be added", () => {
    const w = workspace("cli/ls-nodes-idle.json");
    const [ws] = buildTree([{ ...w, packages: [{ ...w.packages[0]!, files: ["C:/work/wsa/arm/Arm.csproj"] }] }]);
    const arm = sectionOf(ws, "Build systems").find((r) => r.label === "arm/Arm.csproj");
    assert.deepEqual([arm?.ref, arm?.description, arm?.hasRant], ["arm", "no Rant", false]);
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
    assert.deepEqual(ws?.children.map((c) => c.label), ["Packages", "Build systems", "Nodes"]);
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

  it("updates Rant in a workspace or a build system and adds it to one", () => {
    assert.deepEqual(actionArgs("updateRant", { kind: "workspace", ref: "/ws" }), ["lib", "update"]);
    assert.deepEqual(actionArgs("updateRant", { kind: "build", ref: "cam" }), ["lib", "update", "cam"]);
    assert.deepEqual(actionArgs("addRant", { kind: "build", ref: "tools" }), ["lib", "install", "tools"]);
    assert.equal(actionArgs("addRant", { kind: "package", ref: "p" }), undefined);
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
