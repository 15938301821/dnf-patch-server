/**
 * @fileoverview 验证显式 surrender 以数据库时间和精确 lease 关闭 attempt 并重排；
 * 不连接真实 MySQL、不运行 Worker，也不证明 reaper 或多 Worker 并发。
 * @module modules/job/job-surrender-repository-support-spec
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Worker 瞬时错误显式 surrender
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../../../src/common/db/database.service.js";
import { surrenderJobAttempt } from "../../../src/modules/job/job-surrender.repository-support.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const workerId = "33333333-3333-4333-8333-333333333333";
const leaseId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-07-25T00:00:00.000Z");

describe("surrenderJobAttempt", () => {
  it("closes the current attempt and clears the lease before requeue", async () => {
    const harness = createHarness(leaseId);

    await expect(
      surrenderJobAttempt(harness.connection, jobId, {
        workerId,
        leaseId,
        errorCode: "MODEL_PROVIDER_REQUEST_FAILED",
      }),
    ).resolves.toEqual({ status: "requeued" });

    expect(harness.updates).toHaveLength(3);
    expect(harness.updates[0]).toMatchObject({
      status: "failed",
      errorCode: "MODEL_PROVIDER_REQUEST_FAILED",
      finishedAt: now,
    });
    expect(harness.updates[1]).toMatchObject({
      status: "indeterminate",
      errorCode: "PROFESSION_EXECUTION_ATTEMPT_CLOSED",
      finishedAt: now,
    });
    expect(harness.updates[2]).toMatchObject({
      status: "queued",
      leaseOwnerId: null,
      leaseId: null,
      leaseExpiresAt: null,
      updatedAt: now,
    });
    expect(harness.updates[2]?.dispatchReadyAt).toBeDefined();
  });

  it("rejects an old lease without any writes", async () => {
    const harness = createHarness(leaseId);

    await expect(
      surrenderJobAttempt(harness.connection, jobId, {
        workerId,
        leaseId: "55555555-5555-4555-8555-555555555555",
        errorCode: "MODEL_PROVIDER_REQUEST_FAILED",
      }),
    ).resolves.toEqual({ status: "lease-mismatch" });

    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.updates).toEqual([]);
  });
});

function createHarness(currentLeaseId: string): {
  connection: DatabaseService;
  update: ReturnType<typeof vi.fn>;
  updates: Record<string, unknown>[];
} {
  const job = {
    id: jobId,
    runId,
    kind: "inventory",
    status: "leased",
    leaseOwnerId: workerId,
    leaseId: currentLeaseId,
    leaseExpiresAt: new Date("2026-07-25T00:01:00.000Z"),
    dispatchReadyAt: now,
    attemptCount: 1,
    maxAttempts: 3,
  };
  const rows = [[job], [{ value: now }]];
  let selectIndex = 0;
  const select = vi.fn(() => {
    const selectedRows = rows[selectIndex] ?? [];
    selectIndex += 1;
    return { from: vi.fn(() => queryBuilder(selectedRows)) };
  });
  const updates: Record<string, unknown>[] = [];
  const update = vi.fn(() => ({
    set: vi.fn((value: Record<string, unknown>) => ({
      where: vi.fn(() => {
        updates.push(value);
        return Promise.resolve([{ affectedRows: 1 }]);
      }),
    })),
  }));
  const transaction = vi.fn(
    (
      callback: (transaction: {
        select: typeof select;
        update: typeof update;
      }) => unknown,
    ) => Promise.resolve(callback({ select, update })),
  );
  return {
    connection: {
      database: { transaction },
    } as unknown as DatabaseService,
    update,
    updates,
  };
}

function queryBuilder(rows: unknown[]): Record<string, unknown> {
  const query = {
    where: vi.fn(() => query),
    limit: vi.fn(() => query),
    for: vi.fn(() => Promise.resolve(rows)),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ): Promise<unknown> => Promise.resolve(rows).then(resolve, reject),
  };
  return query;
}
