import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { firstError, parseErrors } from "../src/cli/errors.ts";
import { fixture } from "./helpers.ts";

describe("parseErrors", () => {
  const errors = parseErrors(fixture("cli/errors.txt"));

  it("reads file, line, column and message", () => {
    assert.deepEqual(errors[0], { file: "C:/work/wsb/pkgs/other/package.rant", line: 2, column: 1, message: "node `bad` needs `run`" });
    assert.deepEqual(errors[2], { file: "C:/work/wsb/workspace.rant", line: 2, column: 6, message: "syntax error: expected `{`" });
  });

  it("puts an error with a file and no line at line 0", () => {
    assert.equal(errors[1]?.file, "C:/work/wsb/pkgs/dup/package.rant");
    assert.equal(errors[1]?.line, 0);
    assert.match(errors[1]?.message ?? "", /^package name `driver` is also used by C:\\work/);
  });

  it("reads group files", () => {
    assert.equal(errors[3]?.file, "C:/work/wsb/Bad.run");
    assert.equal(errors[3]?.line, 3);
  });

  it("leaves out errors that name no file", () => {
    assert.equal(errors.length, 4);
  });

  it("reads Windows line ends", () => {
    assert.equal(parseErrors("error: /a/package.rant:1:2: x\r\nerror: /a/b.run:3:4: y\r\n").length, 2);
  });
});

describe("firstError", () => {
  it("gives the message of the first error line", () => {
    assert.equal(firstError("noise\nerror: no group named `X`\nerror: other"), "no group named `X`");
    assert.equal(firstError("fine"), undefined);
  });
});
