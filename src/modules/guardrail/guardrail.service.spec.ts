import { describe, expect, it } from "vitest";
import type { GuardrailInput } from "./guardrail.contracts.js";
import { GuardrailService } from "./guardrail.service.js";

const service = new GuardrailService();

function evaluate(payload: GuardrailInput["payload"]): string {
  return service.evaluate({
    policyId: "policy-v2",
    policySha256: "a".repeat(64),
    jobKind: "shared-fx",
    payload,
    deploymentAuthorized: false,
  }).decision;
}

describe("guardrail payload policy", () => {
  it("allows declarative relative metadata", () => {
    expect(
      evaluate({
        profileId: "fixed-profile",
        inputs: ["manifest"],
      }),
    ).toBe("allow");
  });

  it.each([
    { adapter: { executable: "unexpected.exe" } },
    { adapter: { script_path: "C:\\temp\\run.ps1" } },
    { adapter: { "game-directory": "\\\\server\\share" } },
    { metadata: "file:///etc/passwd" },
  ])("rejects unsafe declarative payload %j", (payload) => {
    expect(evaluate(payload)).toBe("deny");
  });
});
