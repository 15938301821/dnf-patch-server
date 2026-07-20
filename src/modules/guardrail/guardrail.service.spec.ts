import { describe, expect, it } from "vitest";

const forbiddenPayloadKeys = new Set([
  "command",
  "executable",
  "gameDirectory",
  "gameProcess",
  "scriptPath",
  "shell",
]);

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenKey);
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) =>
      forbiddenPayloadKeys.has(key) || containsForbiddenKey(child),
  );
}

describe("guardrail payload policy", () => {
  it("allows declarative relative metadata", () => {
    expect(
      containsForbiddenKey({
        profileId: "fixed-profile",
        inputs: ["manifest"],
      }),
    ).toBe(false);
  });

  it("rejects nested arbitrary execution fields", () => {
    expect(
      containsForbiddenKey({ adapter: { executable: "unexpected.exe" } }),
    ).toBe(true);
  });
});
