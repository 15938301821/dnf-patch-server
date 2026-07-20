/**
 * @fileoverview 验证数据库 Job 载荷与 Factory 冻结契约的一致性，不连接数据库。
 * @module job
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan JOB-001-SHARED-FX
 */
import { describe, expect, it } from "vitest";
import { sha256Json } from "../../common/utils/canonical.js";
import {
  type PersistedJobIntegrityInput,
  validatePersistedJobIntegrity,
} from "./job-integrity.js";

const payload = {
  schemaVersion: 1,
  profileId: "runtime-profile",
  parameters: { scope: "shared-fx" },
};
const factoryConfig = {
  schemaVersion: 2 as const,
  profileId: "runtime-profile",
  policyId: "runtime-policy",
  policySha256: "a".repeat(64),
  allowedJobKinds: ["shared-fx" as const],
  jobContracts: [{ kind: "shared-fx" as const, schemaVersion: 1 as const }],
  arbitraryExecution: false,
  deploymentAuthorized: false,
};

function persisted(
  overrides: Partial<PersistedJobIntegrityInput> = {},
): PersistedJobIntegrityInput {
  return {
    kind: "shared-fx",
    payload,
    payloadSha256: sha256Json(payload),
    factoryConfig,
    factoryConfigSha256: sha256Json(factoryConfig),
    ...overrides,
  };
}

describe("validatePersistedJobIntegrity", () => {
  it("accepts a matching persisted Job", () => {
    expect(validatePersistedJobIntegrity(persisted())).toBe(true);
  });

  it.each([
    { payload: { ...payload, parameters: { command: "blocked" } } },
    { payloadSha256: "b".repeat(64) },
    { factoryConfigSha256: "c".repeat(64) },
    { factoryConfig: { ...factoryConfig, profileId: "other-profile" } },
  ])("rejects tampered persisted data %j", (override) => {
    expect(validatePersistedJobIntegrity(persisted(override))).toBe(false);
  });
});
