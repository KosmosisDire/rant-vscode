import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseGroups, parseNodes, parsePackages, parseUses } from "../src/cli/parse.ts";
import { actionArgs, newArgs, validName } from "../src/views/workspaces/actions.ts";
import { buildTree, parents } from "../src/views/workspaces/tree.ts";
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
  // a tree as [label, description] with children, a leaf as the pair alone
  const shape = (nodes: TreeNode[]): unknown[] =>
    nodes.map((n) => (n.children.length ? [n.label, n.description ?? "", shape(n.children)] : [n.label, n.description ?? ""]));

  it("puts nodes and extra build systems under their package, the rest outside", () => {
    const [ws] = buildTree([workspace("cli/ls-nodes-idle.json")]);
    assert.equal(ws?.running, false);
    assert.deepEqual(shape(ws?.children ?? []), [
      ["Packages", "1", [["wsa", "Python, Rant 0.0.22", [["listener", ""], ["talker", ""], [".venv", "Rant 0.0.22"]]]]],
      ["Outside packages", "2", [["cam", "C++, Rant 0.0.21"], ["tools/env", "no Rant"]]],
      ["Groups", "1", [["wsa/WsaGroup", "The talker and the listener", [["talker", ""], ["listener", ""]]]]],
    ]);
    const talker = sectionOf(ws, "Packages")[0]?.children[1];
    assert.deepEqual([talker?.ref, talker?.nodeType, talker?.member], ["wsa/talker", "wsa/talker", undefined]);
  });

  it("shows a running node by its mesh name and marks it under its group", () => {
    const [ws] = buildTree([workspace("cli/ls-nodes-group.json")]);
    assert.equal(ws?.description, "2 running");
    const nodes = sectionOf(ws, "Packages")[0]?.children.filter((c) => c.kind === "node") ?? [];
    assert.deepEqual(nodes.map((n) => [n.label, n.ref, n.running]), [["listener", "listener", true], ["talker", "talker", true]]);
    const group = sectionOf(ws, "Groups")[0];
    assert.equal(group?.running, true);
    assert.deepEqual(group?.children.map((c) => [c.ref, c.running, c.member, c.nodeType]), [
      ["talker", true, true, "wsa/talker"],
      ["listener", true, true, "wsa/listener"],
    ]);
  });

  it("lists a node outside every package with the build systems outside", () => {
    const [ws] = buildTree([workspace("cli/ls-nodes-loose.json")]);
    assert.deepEqual(sectionOf(ws, "Outside packages").map((r) => [r.kind, r.label, r.running]), [
      ["build", "cam", false],
      ["node", "talker", true],
      ["build", "tools/env", false],
    ]);
  });

  it("links an included group to its own row instead of nesting what it runs", () => {
    const w = workspace("cli/ls-nodes-idle.json");
    const all = { name: "All", file: "C:/work/wsa/All.run", description: "", params: "", includes: ["wsa/WsaGroup"], nodes: [] };
    const [ws] = buildTree([{ ...w, groups: [...w.groups, all] }]);
    const link = sectionOf(ws, "Groups")[0]?.children[0];
    assert.deepEqual([link?.kind, link?.ref, link?.children.length], ["include", "wsa/WsaGroup", 0]);
    assert.ok(parents(buildTree([{ ...w, groups: [...w.groups, all] }])).has(`${w.root}|group|wsa/WsaGroup`));
  });

  it("shows a group running inside the group that includes it, with its nodes", () => {
    const w = workspace("cli/ls-nodes-idle.json");
    const base = { name: "BaseGroup", file: "C:/work/wsa/BaseGroup.run", description: "", params: "", includes: [], nodes: [{ name: "motors", type: "wsa/motors" }] };
    const drive = { name: "DriveGroup", file: "C:/work/wsa/DriveGroup.run", description: "", params: "", includes: ["BaseGroup"], nodes: [{ name: "ft", type: "wsa/ft" }] };
    const listing = {
      domain: 0,
      runningGroups: ["DriveGroup"],
      nodes: [
        { name: "ft", type: "wsa/ft", running: true, groups: ["DriveGroup"], domain: 0, group: "DriveGroup" },
        { name: "motors", type: "wsa/motors", running: true, groups: ["DriveGroup"], domain: 0, group: "BaseGroup" },
      ],
    };
    const [ws] = buildTree([{ ...w, groups: [base, drive], listing }]);
    const [baseRow, driveRow] = sectionOf(ws, "Groups");
    assert.deepEqual([baseRow?.label, baseRow?.running, baseRow?.children[0]?.running], ["BaseGroup", true, true]);
    assert.deepEqual(driveRow?.children.map((c) => [c.kind, c.label, c.running]), [
      ["node", "ft", true],
      ["include", "BaseGroup", true],
    ]);
  });

  it("opens build files and group files on a click, a node through its source", () => {
    const [ws] = buildTree([workspace("cli/ls-nodes-idle.json")]);
    const pkg = sectionOf(ws, "Packages")[0];
    assert.equal(pkg?.open, "C:/work/wsa/pyproject.toml");
    assert.equal(pkg?.children.find((c) => c.label === ".venv")?.open, undefined);
    assert.equal(sectionOf(ws, "Outside packages")[0]?.open, "C:/work/wsa/cam/CMakeLists.txt");
    assert.equal(sectionOf(ws, "Groups")[0]?.open, "C:/work/wsa/WsaGroup.run");
    assert.equal(pkg?.children[0]?.open, undefined);
  });

  it("offers Rant by the folder rant lib takes, update where it is, add where not", () => {
    const w = workspace("cli/ls-nodes-idle.json");
    const [ws] = buildTree([w]);
    assert.deepEqual([sectionOf(ws, "Packages")[0]?.lib, sectionOf(ws, "Packages")[0]?.hasRant], [".", true]);
    assert.deepEqual(sectionOf(ws, "Outside packages").map((r) => [r.lib, r.hasRant]), [["cam", true], ["tools", false]]);
    const bare = { ...w.packages[0]!, files: ["C:/work/wsa/arm/Arm.csproj"], kinds: ["csharp"], rant: null, folder: "C:/work/wsa/arm", name: "arm" };
    const declared = { ...w.packages[0]!, files: ["C:/work/wsa/drv/package.rant"], kinds: ["package.rant"], rant: null, folder: "C:/work/wsa/drv", name: "drv" };
    const crate = { ...w.packages[0]!, files: ["C:/work/wsa/jog/Cargo.toml"], kinds: ["rust"], rant: null, folder: "C:/work/wsa/jog", name: "jog" };
    const [more] = buildTree([{ ...w, packages: [bare, declared, crate] }]);
    assert.deepEqual(sectionOf(more, "Packages").map((p) => [p.label, p.description, p.lib, p.hasRant]), [
      ["arm", "C#, no Rant", "arm", false],
      ["drv", "", undefined, undefined],
      ["jog", "Rust, no Rant", "jog", false],
    ]);
  });

  it("gives every row an id that stays the same between builds", () => {
    const a = buildTree([workspace("cli/ls-nodes-group.json")]);
    const b = buildTree([workspace("cli/ls-nodes-group.json")]);
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
    const [ws] = buildTree([{ ...workspace("cli/ls-nodes-idle.json"), groups: [], uses: [] }]);
    assert.deepEqual(ws?.children.map((c) => c.label), ["Packages"]);
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
    assert.deepEqual(actionArgs("updateRant", { kind: "build", ref: "cam/CMakeLists.txt", lib: "cam" }), ["lib", "update", "cam"]);
    assert.deepEqual(actionArgs("updateRant", { kind: "package", ref: "cam", lib: "src/cam" }), ["lib", "update", "src/cam"]);
    assert.deepEqual(actionArgs("addRant", { kind: "build", ref: "tools/env", lib: "tools" }), ["lib", "install", "tools"]);
    assert.equal(actionArgs("addRant", { kind: "package", ref: "drv" }), undefined);
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
    assert.deepEqual(newArgs("package", "jog", "rust"), ["new", "package", "jog", "--lang", "rust", "-y"]);
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
