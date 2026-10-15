import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { discoverWorkspaces, inSkippedDir } from "../src/workspaces/discover.ts";

let tmp = "";

function touch(rel: string): void {
  const file = path.join(tmp, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
}

const rel = (roots: string[]) => roots.map((r) => path.relative(tmp, r).split(path.sep).join("/"));

describe("discoverWorkspaces", () => {
  before(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "vscode-rant-"));
    touch("many/one/workspace.rant");
    touch("many/two/workspace.rant");
    touch("many/deep/er/three/workspace.rant");
    // inside a workspace nothing more is looked for
    touch("many/one/inner/workspace.rant");
    for (const dir of [".git", ".rant", "node_modules", "_deps", "build", "bin", "dist", "target", "out"]) {
      touch(`many/${dir}/hidden/workspace.rant`);
    }
    touch("many/venv/pyvenv.cfg");
    touch("many/venv/lib/workspace.rant");
    touch("many/cmake/CMakeCache.txt");
    touch("many/cmake/sub/workspace.rant");
    touch("single/workspace.rant");
    touch("single/pkg/package.rant");
    touch("empty/readme.md");
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("finds every workspace under one folder", async () => {
    const roots = await discoverWorkspaces([path.join(tmp, "many")]);
    assert.deepEqual(rel(roots), ["many/deep/er/three", "many/one", "many/two"]);
  });

  it("finds nothing in a folder without a workspace", async () => {
    assert.deepEqual(await discoverWorkspaces([path.join(tmp, "empty")]), []);
  });

  it("finds a workspace at the folder itself", async () => {
    assert.deepEqual(rel(await discoverWorkspaces([path.join(tmp, "single")])), ["single"]);
  });

  it("finds the workspace above an opened subfolder", async () => {
    assert.deepEqual(rel(await discoverWorkspaces([path.join(tmp, "single", "pkg")])), ["single"]);
  });

  it("lists a workspace once when two folders reach it", async () => {
    const roots = await discoverWorkspaces([path.join(tmp, "single"), path.join(tmp, "single", "pkg")]);
    assert.deepEqual(rel(roots), ["single"]);
  });

  it("skips a folder that does not exist", async () => {
    assert.deepEqual(await discoverWorkspaces([path.join(tmp, "missing")]), []);
  });
});

describe("inSkippedDir", () => {
  it("tells skipped folders from others", () => {
    assert.equal(inSkippedDir("node_modules/x/a.rant"), true);
    assert.equal(inSkippedDir("pkg\\build\\a.run"), true);
    assert.equal(inSkippedDir("pkg/src/a.run"), false);
    assert.equal(inSkippedDir("workspace.rant"), false);
  });
});
