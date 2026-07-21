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

  it("allows style production payload without executable or path fields", () => {
    expect(
      evaluate({
        schemaVersion: 1,
        profileId: "profile-v2",
        parameters: {
          workflow: "style-skill-production-v1",
          professionId: "11111111-1111-4111-8111-111111111111",
          styleId: "22222222-2222-4222-8222-222222222222",
          selectedSkillIds: ["33333333-3333-4333-8333-333333333333"],
          stylePromptSha256: "A".repeat(64),
          skills: [
            {
              skillId: "33333333-3333-4333-8333-333333333333",
              sourceRunId: "44444444-4444-4444-8444-444444444444",
              sourceFrameManifestArtifactId:
                "55555555-5555-4555-8555-555555555555",
              sourceMetadataSha256: "B".repeat(64),
            },
          ],
          toolProfiles: ["aseprite-cli"],
          deploymentAuthorized: false,
        },
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
