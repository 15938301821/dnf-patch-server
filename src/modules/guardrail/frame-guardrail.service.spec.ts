import { describe, expect, it } from "vitest";

function evaluateAlpha(source: number, candidate: number): boolean {
  return source === 0 || candidate > 0;
}

describe("frame guardrail alpha invariant", () => {
  it("rejects a visible source becoming transparent", () => {
    expect(evaluateAlpha(120, 0)).toBe(false);
  });

  it("allows a source transparent frame to stay transparent", () => {
    expect(evaluateAlpha(0, 0)).toBe(true);
  });
});
