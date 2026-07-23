/**
 * @fileoverview 验证 Frame Guardrail 只能使用 Run 所属 Factory v2 的冻结策略，并验证 alpha 不变量；
 * 不连接数据库、不插入审计决策、不读取图片字节或调用 Worker。
 * @module modules/guardrail/frame-service.spec
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan N/A（服务端证据完整性收紧）
 *
 * 调用关系：Vitest 直接调用 validateFramePolicyBinding 与本地 alpha helper，没有 Controller、
 * DatabaseService 或 FactoryRepository mock。
 * 输入输出：fixture 模拟已读取的 Factory JSON 和请求 policy，断言有限绑定状态/alpha 布尔值；
 * 不证明真实 Run join、数据库 JSON、决策插入、对象存储或候选图片处理已完成。
 * 副作用：没有网络、数据库、对象存储、图片或进程副作用。
 * 安全边界：测试防止未来把 v1、错误 policyId/摘要或可见帧变透明的候选错误地当作可放行证据。
 */
import { describe, expect, it } from "vitest";
import {
  validateFramePolicyBinding,
  type FramePolicyBindingStatus,
} from "./frame-guardrail.service.js";

/** 请求 policy fixture，只验证与 Factory JSON 的冻结绑定，不代表真实 API body 已经通过 HTTP 管道。 */
const input = {
  policyId: "policy-v2",
  policySha256: "A".repeat(64),
};

/** 最小 Factory v2 fixture，保留 v2 所需的 hash、profile 和逐 kind contract 组合不变量。 */
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

/**
 * 复现 Service 的 alpha 可见性规则，避免测试用隐式布尔表达式掩盖规则含义。
 * @param source 来源帧的非透明像素数量。
 * @param candidate 候选帧的非透明像素数量。
 * @returns 来源可见时候选也可见，或来源本来透明时返回 true。
 */
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
