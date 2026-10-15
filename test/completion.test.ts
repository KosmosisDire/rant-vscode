import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { blockAt, suggest } from "../src/language/context.ts";
import { FILE_SCOPES, fileKindOf } from "../src/language/vocabulary.ts";
import type { FileKind } from "../src/language/vocabulary.ts";

const labels = (kind: FileKind, text: string): string[] => suggest(kind, text, text.length).map((s) => s.label);

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
    assert.deepEqual(labels("package", ""), ["name", "build", "depend", "ignore", "python", "domain", "prefix", "node_prefix", "node"]);
  });

  it("offers the group keys and blocks", () => {
    assert.deepEqual(labels("group", ""), ["description", "domain", "prefix", "node_prefix", "param", "include", "node"]);
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
    assert.deepEqual(labels("group", group("  ", 'include "ArmGroup"')), ["expose", "domain", "prefix", "node_prefix"]);
  });

  it("offers the keys of a node in a group", () => {
    assert.deepEqual(labels("group", group("  ", 'node "planner"')), ["name", "args", "env", "domain", "prefix", "node_prefix"]);
  });

  it("offers only run in a package node", () => {
    assert.deepEqual(labels("package", group("  ", 'node "tool"')), ["run"]);
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
  });
});

describe("values", () => {
  it("offers the param types after type =", () => {
    assert.deepEqual(labels("group", 'param "a" {\n  type = '), ["string", "int", "float", "bool"]);
  });

  it("offers true and false after expose =", () => {
    assert.deepEqual(labels("group", 'include "G" {\n  expose = '), ["true", "false"]);
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
    ["group", ["group.rs", "placement.rs"], FILE_SCOPES.group.attributes.map((a) => a.name)],
    ["param", ["param.rs"], FILE_SCOPES.group.blocks.find((b) => b.name === "param")?.attributes.map((a) => a.name) ?? []],
    ["group node", ["group.rs", "placement.rs"], FILE_SCOPES.group.blocks.find((b) => b.name === "node")?.attributes.map((a) => a.name) ?? []],
    ["include", ["group.rs", "placement.rs"], FILE_SCOPES.group.blocks.find((b) => b.name === "include")?.attributes.map((a) => a.name) ?? []],
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
