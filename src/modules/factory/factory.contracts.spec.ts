import { describe, expect, it } from "vitest";
import { factoryConfigSchema } from "./factory.contracts.js";

const policySha256 = "A".repeat(64);

describe("factoryConfigSchema", () => {
  it("保留 Factory v1 的只读解析兼容性", () => {
    expect(
      factoryConfigSchema.safeParse({
        schemaVersion: 1,
        profileId: "profile-v1",
        policyId: "policy-v1",
        allowedJobKinds: ["context-freeze"],
        arbitraryExecution: false,
        deploymentAuthorized: false,
      }).success,
    ).toBe(true);
  });

  it("接受策略和任务契约完全冻结的 Factory v2", () => {
    expect(
      factoryConfigSchema.safeParse({
        schemaVersion: 2,
        profileId: "profile-v2",
        policyId: "policy-v2",
        policySha256,
        allowedJobKinds: ["context-freeze", "inventory"],
        jobContracts: [
          { kind: "context-freeze", schemaVersion: 1 },
          { kind: "inventory", schemaVersion: 1 },
        ],
        arbitraryExecution: false,
        deploymentAuthorized: false,
      }).success,
    ).toBe(true);
  });

  it("拒绝 jobContracts 与白名单不完全对应", () => {
    const result = factoryConfigSchema.safeParse({
      schemaVersion: 2,
      profileId: "profile-v2",
      policyId: "policy-v2",
      policySha256,
      allowedJobKinds: ["context-freeze", "inventory"],
      jobContracts: [{ kind: "context-freeze", schemaVersion: 1 }],
      arbitraryExecution: false,
      deploymentAuthorized: false,
    });
    expect(result.success).toBe(false);
  });
});
