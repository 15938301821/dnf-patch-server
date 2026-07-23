/**
 * @fileoverview 验证 Factory 配置版本与冻结 Job contract 的输入边界；不连接 MySQL、创建 Factory、Run、
 * Worker 或执行任何本机工具。
 * @module modules/factory/contracts.spec
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Vitest 直接解析 factoryConfigSchema；没有 Controller、Service 或 Repository Mock。
 * 输入输出：输入是最小 JSON fixture，输出是 Zod 成功/失败结果；不会证明数据库 JSON、事务或真实
 * Worker capability 已联通。
 * 副作用：没有网络、数据库、对象存储或进程副作用。
 * 安全边界：测试防止 v2 白名单与逐 kind contract 脱节；schema 接受 v1 只证明历史读取兼容，
 * 不授权创建新的 v1 Run。
 */
import { describe, expect, it } from "vitest";
import { factoryConfigSchema } from "./factory.contracts.js";

/** 固定 64 位摘要 fixture，只用于验证 schema 形状，不代表真实策略文件内容。 */
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
