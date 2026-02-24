import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeBridgePort } from "./extension-bridge-config";

describe("normalizeBridgePort", () => {
  it("uses default when not finite", () => {
    assert.equal(normalizeBridgePort(Number.NaN), 27123);
  });

  it("clamps lower bound", () => {
    assert.equal(normalizeBridgePort(12), 1024);
  });

  it("clamps upper bound", () => {
    assert.equal(normalizeBridgePort(70000), 65535);
  });

  it("returns integer port in range", () => {
    assert.equal(normalizeBridgePort(27123.9), 27123);
  });
});
