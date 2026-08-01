/**
 * @fileoverview 验证Job attempt关闭时同步收口V6逐帧生成；不连接MySQL、不调用Provider或对象存储。
 * @module modules/job/job-attempt-close-repository-support-spec
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - R4真实逐帧长跑租约恢复
 *
 * Mock边界：最小Drizzle transaction fake返回同attempt的两个非终态帧，并记录四类更新。
 * 测试保护attempt、旧V2执行、V6 ModelCall与目标帧在同一事务收口；真实行锁/CHECK由MySQL验证。
 */
import { describe, expect, it, vi } from "vitest";
import { professionSkillFrameTargets } from "../../../src/common/db/profession-frame-target-schema.js";
import { jobAttempts, modelCalls } from "../../../src/common/db/schema.js";
import type { jobs } from "../../../src/common/db/schema.js";
import { professionSkillModelExecutions } from "../../../src/common/db/profession-model-execution-schema.js";
import { closeJobAttempt } from "../../../src/modules/job/job-attempt-close.repository-support.js";
import type { JobTransaction } from "../../../src/modules/job/job-run-event.repository-support.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const workerId = "33333333-3333-4333-8333-333333333333";
const leaseId = "44444444-4444-4444-8444-444444444444";
const modelCallId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-07-31T00:00:00.000Z");

describe("closeJobAttempt", () => {
  it("同事务关闭V6非终态帧及其running ModelCall", async () => {
    const updates: Array<{
      target: unknown;
      value: Record<string, unknown>;
    }> = [];
    const activeTargets = [
      {
        id: "66666666-6666-4666-8666-666666666666",
        modelCallId,
      },
      {
        id: "77777777-7777-4777-8777-777777777777",
        modelCallId: null,
      },
    ];
    const select = vi.fn(() => ({
      from: vi.fn((target: unknown) => {
        expect(target).toBe(professionSkillFrameTargets);
        const query = {
          where: vi.fn(() => query),
          for: vi.fn().mockResolvedValue(activeTargets),
        };
        return query;
      }),
    }));
    const update = vi.fn((target: unknown) => ({
      set: vi.fn((value: Record<string, unknown>) => ({
        where: vi.fn(() => {
          updates.push({ target, value });
          return Promise.resolve([{ affectedRows: 1 }]);
        }),
      })),
    }));
    const transaction = { select, update } as unknown as JobTransaction;
    const job: typeof jobs.$inferSelect = {
      id: jobId,
      runId,
      kind: "profession",
      status: "leased",
      payload: {},
      payloadSha256: "A".repeat(64),
      leaseOwnerId: workerId,
      leaseId,
      leaseExpiresAt: new Date("2026-07-31T00:01:00.000Z"),
      dispatchReadyAt: now,
      attemptCount: 2,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
    };

    await closeJobAttempt(transaction, job, now, "timed_out", "LEASE_EXPIRED");

    expect(updateValue(updates, jobAttempts)).toMatchObject({
      status: "timed_out",
      errorCode: "LEASE_EXPIRED",
      finishedAt: now,
    });
    expect(updateValue(updates, professionSkillModelExecutions)).toMatchObject({
      status: "indeterminate",
      errorCode: "PROFESSION_EXECUTION_ATTEMPT_CLOSED",
      finishedAt: now,
    });
    expect(updateValue(updates, modelCalls)).toEqual({
      status: "abandoned",
      errorCode: "MODEL_CALL_ABANDONED_AFTER_ATTEMPT_CLOSED",
      finishedAt: now,
    });
    expect(updateValue(updates, professionSkillFrameTargets)).toMatchObject({
      generationStatus: "blocked",
      generationErrorCode: "PROFESSION_EXECUTION_ATTEMPT_CLOSED",
      targetPngSha256: null,
      targetPngByteLength: null,
      targetNormalizationAlgorithm: null,
      generationFinishedAt: now,
    });
  });
});

function updateValue(
  updates: readonly { target: unknown; value: Record<string, unknown> }[],
  target: unknown,
): Record<string, unknown> | undefined {
  return updates.find((update) => update.target === target)?.value;
}
