import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { parseGroups, parseNodes, parsePackages, parseUses } from "../src/cli/parse.ts";
import { blockAt, knownFrom, suggest } from "../src/language/context.ts";
import type { Known } from "../src/language/context.ts";
import { FILE_SCOPES, fileKindOf } from "../src/language/vocabulary.ts";
import type { FileKind } from "../src/language/vocabulary.ts";
import type { WorkspaceData } from "../src/workspaces/load.ts";
import { fixture } from "./helpers.ts";

const labels = (kind: FileKind, text: string, known?: Known): string[] => suggest(kind, text, text.length, known).map((s) => s.label);

describe("fileKindOf", () => {
  it("tells the three file kinds apart", () => {
    assert.equal(fileKindOf("C:\\x\\workspace.rant"), "workspace");
    assert.equal(fileKindOf("/x/package.rant"), "package");
    assert.equal(fileKindOf("/x/NavGroup.run"), "group");
    assert.equal(fileKindOf("/x/other.rant"), undefined);
  });
});

describe("keys per file kind", () => {
  it("offers the workspace keys and no blocks", () => {
    assert.deepEqual(labels("workspace", ""), ["logs", "ignore", "domain", "prefix", "node_prefix"]);
  });

  it("offers the package keys and the node block", () => {
    assert.deepEqual(labels("package", ""), [
      "name",
      "description",
      "build",
      "depend",
      "ignore",
      "python",
      "domain",
      "prefix",
      "node_prefix",
      "node",
    ]);
  });

  it("offers the group keys and blocks", () => {
    assert.deepEqual(labels("group", ""), ["description", "domain", "prefix", "node_prefix", "restart", "param", "include", "node"]);
  });

  it("filters nothing itself, the editor does by the word typed", () => {
    assert.equal(labels("group", "desc").includes("description"), true);
  });

  it("gives every entry a doc", () => {
    for (const kind of ["workspace", "package", "group"] as const) {
      for (const s of suggest(kind, "", 0)) assert.notEqual(s.doc, "", `${kind} ${s.label}`);
    }
  });

  it("makes a block a snippet with a label stop", () => {
    const node = suggest("package", "", 0).find((s) => s.label === "node");
    assert.equal(node?.kind, "block");
    assert.equal(node?.insert, 'node "${1:node name}" {\n\t$0\n}');
  });
});

describe("keys inside blocks", () => {
  const group = (inside: string, open: string) => `${open} {\n${inside}`;

  it("offers the keys of a param", () => {
    assert.deepEqual(labels("group", group("  ", 'param "speed"')), ["type", "options", "default", "description"]);
  });

  it("offers the keys of an include", () => {
    assert.deepEqual(labels("group", group("  ", 'include "ArmGroup"')), ["expose", "domain", "prefix", "node_prefix", "restart"]);
  });

  it("offers the keys of a node in a group", () => {
    assert.deepEqual(labels("group", group("  ", 'node "planner"')), ["name", "args", "env", "domain", "prefix", "node_prefix", "restart"]);
  });

  it("offers run and expect_mesh in a package node", () => {
    assert.deepEqual(labels("package", group("  ", 'node "tool"')), ["run", "expect_mesh"]);
  });

  it("leaves out keys the block sets already, written before or after the cursor", () => {
    const text = 'node "n" {\n  name = "a"\n  ';
    const after = '\n  args = "-v"\n  env = { A = "1" }\n}\n';
    assert.deepEqual(suggest("group", text + after, text.length).map((s) => s.label), ["domain", "prefix", "node_prefix", "restart"]);
    assert.deepEqual(labels("workspace", 'domain = 3\nlogs = "l"\n'), ["ignore", "prefix", "node_prefix"]);
  });

  it("goes back to the top after the block closes", () => {
    assert.equal(labels("group", 'param "a" {\n}\n').includes("param"), true);
  });

  it("offers nothing inside an object, a list, a string or a comment", () => {
    assert.deepEqual(labels("group", 'node "n" {\n  env = {\n    '), []);
    assert.deepEqual(labels("group", 'node "n" {\n  args = [\n    '), []);
    assert.deepEqual(labels("group", 'description = "so'), []);
    assert.deepEqual(labels("group", "# a comment "), []);
    assert.deepEqual(labels("group", "description = <<EOF\ntext\n"), []);
    const comment = "# a comment\n";
    assert.deepEqual(suggest("group", comment, comment.length - 1).map((s) => s.label), []);
  });
});

describe("names from the workspace", () => {
  const known: Known = {
    nodes: [{ name: "talker", doc: "" }, { name: "cam/camera", doc: "" }],
    groups: [{ name: "ArmGroup", doc: "", params: ["speed", "side"] }],
    packages: [{ name: "cam", doc: "" }],
  };

  it("offers node types in a group's node label and groups in an include label", () => {
    assert.deepEqual(labels("group", 'node "', known), ["talker", "cam/camera"]);
    assert.deepEqual(labels("group", 'node "ca', known), ["talker", "cam/camera"]);
    assert.deepEqual(labels("group", 'include "', known), ["ArmGroup"]);
    assert.deepEqual(labels("package", 'node "', known), []);
    assert.deepEqual(labels("group", 'node "a" {\n  name = "', known), []);
  });

  it("offers packages in a depend list and an included group's params to expose", () => {
    assert.deepEqual(labels("package", 'depend = ["', known), ["cam"]);
    assert.deepEqual(labels("package", 'depend = ["cam", "', known), ["cam"]);
    assert.deepEqual(labels("package", 'depend = ["cam"', known), []);
    assert.deepEqual(labels("group", 'include "ArmGroup" {\n  expose = ["', known), ["speed", "side"]);
  });

  it("offers an included group's params as keys of its include", () => {
    assert.deepEqual(labels("group", 'include "ArmGroup" {\n  speed = 2\n  ', known), ["expose", "domain", "prefix", "node_prefix", "restart", "side"]);
  });

  it("leaves a block's label empty and opens the list there when names are known", () => {
    const node = suggest("group", "", 0, known).find((s) => s.label === "node");
    assert.deepEqual([node?.insert, node?.more], ['node "$1" {\n\t$0\n}', true]);
    const param = suggest("group", "", 0, known).find((s) => s.label === "param");
    assert.deepEqual([param?.insert, param?.more], ['param "${1:param name}" {\n\t$0\n}', false]);
  });

  it("names each node and group as short as the CLI still finds it from the file", () => {
    const pkg = (name: string) => ({ name, kinds: ["cmake"], folder: `C:/ws/${name}`, files: [] });
    const group = (name: string, file: string) => ({ name, file, description: "", params: "", includes: [], nodes: [] });
    const idle = (name: string) => ({ name, kind: "native" });
    const w: WorkspaceData = {
      root: "C:/ws",
      name: "ws",
      packages: parsePackages(JSON.stringify([pkg("arm"), pkg("cam"), pkg("bridge")])),
      groups: [
        group("arm/Drive", "C:/ws/arm/Drive.run"),
        group("cam/Drive", "C:/ws/cam/Drive.run"),
        group("bridge/Bridge", "C:/ws/bridge/Bridge.run"),
        group("Cell", "C:/ws/Cell.run"),
      ],
      uses: [],
      listing: parseNodes(JSON.stringify({ domain: 0, groups: [], nodes: [], not_running: ["arm/driver", "cam/driver", "bridge/bridge"].map(idle) })),
    };
    const top = knownFrom(w, "C:/ws/Cell.run");
    assert.deepEqual(top.nodes.map((n) => n.name), ["arm/driver", "bridge", "cam/driver"]);
    assert.deepEqual(top.groups.map((g) => g.name), ["arm/Drive", "Bridge", "cam/Drive"]);
    const inArm = knownFrom(w, "C:/ws/arm/Other.run");
    assert.deepEqual(inArm.groups.map((g) => g.name), ["Bridge", "cam/Drive", "Cell", "Drive"]);
  });

  it("names a file outside every package by its own name and skips the file's own group", () => {
    const w: WorkspaceData = {
      root: "C:/work/wsa",
      name: "wsa",
      packages: parsePackages(fixture("cli/ls-packages.json")),
      groups: [
        ...parseGroups(fixture("cli/ls-groups.json")),
        { name: "Other", file: "C:/work/Other.run", description: "", params: "speed=1 target=?", includes: [], nodes: [] },
      ],
      uses: parseUses(fixture("cli/ls-libraries.json")),
      listing: parseNodes(fixture("cli/ls-nodes-loose.json")),
    };
    const k = knownFrom(w, "C:/work/wsa/WsaGroup.run");
    assert.deepEqual(k.nodes.map((n) => n.name), ["listener", "talker"]);
    assert.deepEqual(k.groups.map((g) => [g.name, g.params]), [["Other", ["speed", "target"]]]);
    assert.deepEqual(k.packages, []);
  });
});

describe("values", () => {
  it("offers the param types after type =", () => {
    assert.deepEqual(labels("group", 'param "a" {\n  type = '), ["string", "int", "float", "bool", "path"]);
  });

  it("offers true and false after expose =", () => {
    assert.deepEqual(labels("group", 'include "G" {\n  expose = '), ["true", "false"]);
  });

  it("offers the three restarts after restart =", () => {
    assert.deepEqual(labels("group", "restart = "), ['"never"', '"on-failure"', '"always"']);
  });

  it("offers path and the params of the group after another key", () => {
    const text = 'param "speed" {\n}\nnode "n" {\n  args = param.';
    assert.deepEqual(labels("group", text), ["path.file", "path.package", "path.workspace", "param.speed"]);
  });

  it("offers path only in a package", () => {
    assert.deepEqual(labels("package", "build = "), ["path.file", "path.package", "path.workspace"]);
  });
});

describe("blockAt", () => {
  it("tracks braces past strings and comments", () => {
    const text = 'node "a{" { # }\n  env = "}"\n';
    assert.equal(blockAt(text, text.length), "node");
  });

  it("sees an interpolation inside a string as the string", () => {
    const text = 'node "a" {\n  args = "--x ${param.';
    assert.equal(blockAt(text, text.length), null);
  });
});

describe("vocabulary against the crate", () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../cli-rant/config/src");
  const have = existsSync(src);
  const crate = (...files: string[]) => (have ? files.map((f) => readFileSync(path.join(src, f), "utf8")).join("\n") : "");

  const expect: Array<[string, string[], string[]]> = [
    ["workspace", ["workspace.rs", "placement.rs"], FILE_SCOPES.workspace.attributes.map((a) => a.name)],
    ["package", ["package.rs", "placement.rs"], FILE_SCOPES.package.attributes.map((a) => a.name)],
    ["group", ["group.rs", "placement.rs", "plan.rs"], FILE_SCOPES.group.attributes.map((a) => a.name)],
    ["param", ["param.rs"], FILE_SCOPES.group.blocks.find((b) => b.name === "param")?.attributes.map((a) => a.name) ?? []],
    ["group node", ["group.rs", "placement.rs", "plan.rs"], FILE_SCOPES.group.blocks.find((b) => b.name === "node")?.attributes.map((a) => a.name) ?? []],
    ["include", ["group.rs", "placement.rs", "plan.rs"], FILE_SCOPES.group.blocks.find((b) => b.name === "include")?.attributes.map((a) => a.name) ?? []],
    ["package node", ["package.rs"], FILE_SCOPES.package.blocks.flatMap((b) => b.attributes.map((a) => a.name))],
  ];

  for (const [what, files, names] of expect) {
    it(`names the ${what} keys the crate reads`, { skip: have ? false : "cli-rant is not beside this folder" }, () => {
      const text = crate(...files);
      for (const name of names) assert.equal(text.includes(`"${name}"`), true, `${name} is not in ${files.join(", ")}`);
    });
  }

  it("names the blocks the crate reads", { skip: have ? false : "cli-rant is not beside this folder" }, () => {
    for (const block of ["param", "include", "node"]) assert.equal(crate("group.rs").includes(`"${block}"`), true, block);
    assert.equal(crate("package.rs").includes('"node"'), true);
  });
});
