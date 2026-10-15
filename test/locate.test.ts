import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { locateCli } from "../src/cli/locate.ts";
import { shellLine } from "../src/cli/shell.ts";
import { pathKey, rootOf } from "../src/workspaces/paths.ts";

const files = (...list: string[]) => (f: string) => list.includes(f);

describe("locateCli", () => {
  it("uses the setting when it exists", () => {
    const cli = locateCli({ setting: "/opt/rant", pathEnv: "/usr/bin", home: "/home/u", platform: "linux", exists: files("/opt/rant") });
    assert.deepEqual(cli, { exe: "/opt/rant", display: "/opt/rant" });
  });

  it("does not fall back when the setting is wrong", () => {
    const cli = locateCli({ setting: "/opt/none", pathEnv: "/usr/bin", home: "/home/u", platform: "linux", exists: files("/usr/bin/rant") });
    assert.equal(cli, undefined);
  });

  it("expands ~ in the setting", () => {
    const cli = locateCli({ setting: "~/bin/rant", pathEnv: "", home: "/home/u", platform: "linux", exists: files("/home/u/bin/rant") });
    assert.equal(cli?.exe, "/home/u/bin/rant");
  });

  it("finds rant on PATH and shows the bare name", () => {
    const cli = locateCli({ setting: "", pathEnv: "/a:/usr/bin", home: "/home/u", platform: "linux", exists: files("/usr/bin/rant") });
    assert.deepEqual(cli, { exe: "/usr/bin/rant", display: "rant" });
  });

  it("falls back to ~/.rant/bin", () => {
    const cli = locateCli({ setting: "", pathEnv: "/a", home: "/home/u", platform: "linux", exists: files("/home/u/.rant/bin/rant") });
    assert.equal(cli?.exe, "/home/u/.rant/bin/rant");
  });

  it("looks for rant.exe on Windows", () => {
    const home = "C:\\Users\\u";
    const exe = "C:\\Users\\u\\.rant\\bin\\rant.exe";
    const cli = locateCli({ setting: "", pathEnv: "C:\\Windows;C:\\bin", home, platform: "win32", exists: files(exe) });
    assert.deepEqual(cli, { exe, display: exe });
    const onPath = locateCli({ setting: "", pathEnv: "C:\\Windows;C:\\bin", home, platform: "win32", exists: files("C:\\bin\\rant.exe") });
    assert.equal(onPath?.display, "rant");
  });

  it("finds nothing", () => {
    assert.equal(locateCli({ setting: "", pathEnv: undefined, home: "/h", platform: "linux", exists: () => false }), undefined);
  });
});

describe("shellLine", () => {
  it("leaves plain words alone", () => {
    assert.equal(shellLine("rant", ["run", "node", "wsa/talker"], "/bin/bash"), "rant run node wsa/talker");
  });

  it("quotes a program path with spaces for each shell", () => {
    const exe = "C:\\Program Files\\rant\\rant.exe";
    assert.equal(shellLine(exe, ["build"], "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), `& "${exe}" build`);
    assert.equal(shellLine(exe, ["build"], "C:\\Windows\\System32\\cmd.exe"), `"${exe}" build`);
    assert.equal(shellLine(exe, ["build"], "C:\\Program Files\\Git\\bin\\bash.exe"), '"C:\\\\Program Files\\\\rant\\\\rant.exe" build');
  });

  it("quotes arguments with spaces", () => {
    assert.equal(shellLine("rant", ["run", "G", "msg=a b"], "/bin/bash"), 'rant run G "msg=a b"');
  });
});

describe("paths", () => {
  it("compares Windows paths without case and slash direction", () => {
    assert.equal(pathKey("C:\\Work\\Ws\\", "win32"), pathKey("c:/work/ws", "win32"));
    assert.notEqual(pathKey("/Work/Ws", "linux"), pathKey("/work/ws", "linux"));
  });

  it("finds the deepest root that holds a file", () => {
    const roots = ["/ws", "/ws/inner", "/other"];
    assert.equal(rootOf(roots, "/ws/inner/a.run", "linux"), "/ws/inner");
    assert.equal(rootOf(roots, "/ws/pkg/package.rant", "linux"), "/ws");
    assert.equal(rootOf(roots, "/wsx/a.run", "linux"), undefined);
  });
});
