import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { meshText, outputLine } from "../src/views/mesh/logText.ts";

const at = Date.UTC(2026, 9, 19, 22, 46, 37, 123) * 1000;

describe("meshText", () => {
  it("leads with the sender's time and the level, and marks Rant's own lines", () => {
    assert.equal(meshText({ level: "warn", origin: "app", node: "arm", text: "battery at 20 percent", wallUs: at }, false),
      "22:46:37.123 WARN  battery at 20 percent");
    assert.equal(meshText({ level: "error", origin: "rant", node: "arm", text: "schema-mismatch", wallUs: at }, true),
      "22:46:37.123 ERROR arm (Rant): schema-mismatch");
  });
});

describe("outputLine", () => {
  it("takes the line out of a rant log record and nothing else", () => {
    assert.equal(outputLine('{"node":"arm","line":"rant[arm]: started"}'), "rant[arm]: started");
    assert.equal(outputLine("not json"), undefined);
    assert.equal(outputLine('{"node":"arm"}'), undefined);
  });
});
