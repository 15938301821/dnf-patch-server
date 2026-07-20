import { describe, expect, it } from "vitest";
import { secureEqual } from "./client-token.guard.js";

describe("constant-time token comparison", () => {
  it("accepts identical values", () => {
    expect(secureEqual("a".repeat(32), "a".repeat(32))).toBe(true);
  });

  it("rejects mismatched lengths and values", () => {
    expect(secureEqual("short", "a".repeat(32))).toBe(false);
    expect(secureEqual("b".repeat(32), "a".repeat(32))).toBe(false);
  });
});
