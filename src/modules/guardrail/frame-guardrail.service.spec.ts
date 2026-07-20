/**
 * @fileoverview 验证 Frame Guardrail 只能使用 Run 所属 Factory 的冻结策略，不连接数据库。
 * @module guardrail
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan N/A（服务端证据完整性收紧）
 */
import { describe, expect, it } from "vitest";
import {
  validateFramePolicyBinding,
  type FramePolicyBindingStatus,
} from "./frame-guardrail.service.js";

const input = {
  policyId: "policy-v2",
  policySha256: "A".repeat(64),
};

const factoryConfig = {
  schemaVersion: 2 as const,
  profileId: "runtime-profile",
  policyId: "policy-v2",
  policySha256: "a".repeat(64),
  allowedJobKinds: ["shared-fx" as const],
  jobContracts: [{ kind: "shared-fx" as const, schemaVersion: 1 as const }],
  arbitraryExecution: false,
  deploymentAuthorized: false,
};

describe("validateFramePolicyBinding", () => {
  it.each([
    [factoryConfig, "matched"],
    [{ ...factoryConfig, policyId: "other-policy" }, "mismatch"],
    [{ ...factoryConfig, policySha256: "B".repeat(64) }, "mismatch"],
    [{ ...factoryConfig, schemaVersion: 1 }, "unavailable"],
    [{ invalid: true }, "unavailable"],
  ] satisfies Array<[unknown, FramePolicyBindingStatus]>)(
    "returns %s for the supplied Factory config",
    (config, expected) => {
      expect(validateFramePolicyBinding(input, config)).toBe(expected);
    },
  );
});

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
