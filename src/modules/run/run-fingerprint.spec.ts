/**
 * @fileoverview 验证 Run 幂等指纹对 JSON 键顺序/哈希大小写稳定，并隔离不同请求语义和稳定 owner；
 * 不查询数据库、不处理唯一键竞争、不创建 Run、Job 或 outbox。
 * @module modules/run/fingerprint.spec
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Vitest 直接通过 createRunSchema 创建最小合法 DTO，再调用 createRunRequestFingerprint；没有
 * Controller、RunService、Repository、认证或 MySQL mock。
 * 输入输出：输入是内存 DTO fixture，输出是哈希字符串相等/不等断言；不证明实际 Idempotency-Key 行锁、
 * 数据库唯一键、Service 重放错误或跨进程竞争处理。
 * 副作用：无网络、数据库、对象存储、Worker、模型或进程副作用。
 * 安全边界：测试阻止未来忽略完整请求语义或 owner，使不同用户/不同 Job 以同一个 key 错误重放。
 */
import { describe, expect, it } from "vitest";
import { createRunSchema, type CreateRunInput } from "./run.contracts.js";
import { createRunRequestFingerprint } from "./run-fingerprint.js";

/**
 * 构造最小合法 Run DTO fixture。
 * @returns 已经 schema 解析的内存输入；仅测试指纹规范化，不证明 Factory/Project/Job contract 可真实使用。
 */
function runInput(): CreateRunInput {
  return createRunSchema.parse({
    projectId: "11111111-1111-4111-8111-111111111111",
    snapshotId: "22222222-2222-4222-8222-222222222222",
    clientRunId: "client-run",
    action: "validate-only",
    requestSha256: "a".repeat(64),
    jobs: [
      {
        kind: "context-freeze",
        payload: {
          schemaVersion: 1,
          profileId: "profile-v2",
          parameters: { alpha: 1, beta: 2 },
        },
        maxAttempts: 2,
      },
    ],
    policyId: "policy-v2",
    policySha256: "b".repeat(64),
  });
}

describe("createRunRequestFingerprint", () => {
  it("规范化证据哈希大小写与 JSON 对象键顺序", () => {
    const first = runInput();
    const reordered = createRunSchema.parse({
      ...first,
      requestSha256: first.requestSha256.toUpperCase(),
      policySha256: first.policySha256.toUpperCase(),
      jobs: [
        {
          ...first.jobs[0],
          payload: {
            schemaVersion: 1,
            profileId: "profile-v2",
            parameters: { beta: 2, alpha: 1 },
          },
        },
      ],
    });
    expect(createRunRequestFingerprint(first)).toBe(
      createRunRequestFingerprint(reordered),
    );
  });

  it("请求语义变化时生成不同指纹", () => {
    const first = runInput();
    const changed = createRunSchema.parse({
      ...first,
      clientRunId: "different-client-run",
    });
    expect(createRunRequestFingerprint(first)).not.toBe(
      createRunRequestFingerprint(changed),
    );
  });

  it("不同 owner 不能复用同一个幂等指纹", () => {
    const input = runInput();
    expect(
      createRunRequestFingerprint(
        input,
        "11111111-1111-4111-8111-111111111111",
      ),
    ).not.toBe(
      createRunRequestFingerprint(
        input,
        "22222222-2222-4222-8222-222222222222",
      ),
    );
  });
});
