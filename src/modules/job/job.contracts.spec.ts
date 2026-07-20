/**
 * @fileoverview 验证 Job 完成请求的结果证据和错误码边界，不连接数据库。
 * @module job
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan N/A（服务端 Job 完成契约收紧）
 */
import { describe, expect, it } from "vitest";
import { completeJobSchema } from "./job.contracts.js";

const workerId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
const resultSha256 = "A".repeat(64);

const base = {
  workerId,
  leaseId,
};

describe("completeJobSchema", () => {
  it("requires a result hash for passed jobs", () => {
    expect(
      completeJobSchema.safeParse({ ...base, status: "passed" }).success,
    ).toBe(false);
    expect(
      completeJobSchema.safeParse({
        ...base,
        status: "passed",
        resultSha256,
      }).success,
    ).toBe(true);
  });

  it("requires a stable error code for failed and blocked jobs", () => {
    expect(
      completeJobSchema.safeParse({ ...base, status: "failed" }).success,
    ).toBe(false);
    expect(
      completeJobSchema.safeParse({
        ...base,
        status: "failed",
        errorCode: "WORKER_FAILED",
      }).success,
    ).toBe(true);
    expect(
      completeJobSchema.safeParse({
        ...base,
        status: "blocked",
        errorCode: "GUARDRAIL_BLOCKED",
      }).success,
    ).toBe(true);
  });
});
