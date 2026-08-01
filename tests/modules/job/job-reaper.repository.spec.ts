/**
 * @fileoverview 验证lease reaper只在重试耗尽时同步关闭npk-package聚合；不启动定时器、
 * 不连接真实MySQL，也不证明SKIP LOCKED在并发连接下的运行语义。
 * @module modules/job/job-reaper-repository-spec
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3终态旁路审计
 *
 * Mock边界：最小Drizzle transaction fake按查询顺序返回过期Job、数据库时间和Run聚合；
 * 测试保护Job/attempt/Package/Run同事务写入顺序，真实行锁与CHECK仍由test:mysql验证。
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../../../src/common/db/database.service.js";
import { stylePackages } from "../../../src/common/db/style-package-schema.js";
import { JobRepository } from "../../../src/modules/job/job.repository.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const workerId = "33333333-3333-4333-8333-333333333333";
const leaseId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-07-25T00:00:00.000Z");

describe("JobRepository.reapExpired Package terminal state", () => {
  it("keeps the package aggregate active while another attempt remains", async () => {
    const harness = createHarness(2, 3);

    await expect(harness.repository.reapExpired(10)).resolves.toEqual([]);

    expect(harness.updateTargets).not.toContain(stylePackages);
    expect(harness.updates).toContainEqual(
      expect.objectContaining({
        status: "queued",
        leaseOwnerId: null,
        leaseId: null,
      }),
    );
  });

  it("closes the package aggregate when the final attempt expires", async () => {
    const harness = createHarness(3, 3);

    await harness.repository.reapExpired(10);

    const packageUpdateIndex = harness.updateTargets.indexOf(stylePackages);
    expect(packageUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(harness.updates[packageUpdateIndex]).toEqual({
      status: "failed",
      updatedAt: now,
      finishedAt: now,
    });
  });

  it("closes an already-dispatched legacy package when Profession exhausts", async () => {
    const harness = createHarness(3, 3, new Date("2026-07-24T23:58:00.000Z"));

    await expect(harness.repository.reapExpired(10)).resolves.toEqual([]);

    expect(harness.updates).toContainEqual(
      expect.objectContaining({ status: "failed", leaseId: null }),
    );
  });
});

interface ReaperHarness {
  repository: JobRepository;
  updateTargets: unknown[];
  updates: Record<string, unknown>[];
}

/** 按reaper真实查询顺序提供单个过期Package Job及其Run聚合视图。 */
function createHarness(
  attemptCount: number,
  maxAttempts: number,
  packageDispatchReadyAt: Date | null = null,
): ReaperHarness {
  const job = {
    id: jobId,
    runId,
    kind: "npk-package",
    status: "leased",
    leaseOwnerId: workerId,
    leaseId,
    leaseExpiresAt: new Date("2026-07-24T23:59:00.000Z"),
    attemptCount,
    maxAttempts,
    createdAt: new Date("2026-07-24T00:00:00.000Z"),
  };
  const rows =
    attemptCount >= maxAttempts
      ? [
          [job],
          [{ value: now }],
          [],
          [{ id: runId }],
          [
            {
              id: "55555555-5555-4555-8555-555555555555",
              status: "queued",
              dispatchReadyAt: packageDispatchReadyAt,
            },
          ],
          [{ id: jobId, status: "failed" }],
          [{ sequence: null }],
        ]
      : [[job], [{ value: now }], []];
  let selectIndex = 0;
  const select = vi.fn(() => {
    const selectedRows = rows[selectIndex] ?? [];
    selectIndex += 1;
    return { from: vi.fn(() => queryBuilder(selectedRows)) };
  });
  const updateTargets: unknown[] = [];
  const updates: Record<string, unknown>[] = [];
  const update = vi.fn((target: unknown) => {
    updateTargets.push(target);
    return {
      set: vi.fn((value: Record<string, unknown>) => ({
        where: vi.fn(() => {
          updates.push(value);
          return Promise.resolve([{ affectedRows: 1 }]);
        }),
      })),
    };
  });
  const insert = vi.fn(() => ({
    values: vi.fn().mockResolvedValue(undefined),
  }));
  const transaction = vi.fn(
    (
      callback: (transaction: {
        select: typeof select;
        update: typeof update;
        insert: typeof insert;
      }) => unknown,
    ) => Promise.resolve(callback({ select, update, insert })),
  );
  const connection = {
    database: { transaction },
  } as unknown as DatabaseService;
  return {
    repository: new JobRepository(connection),
    updateTargets,
    updates,
  };
}

/** 模拟reaper使用的where/orderBy/limit/FOR UPDATE与普通thenable查询链。 */
function queryBuilder(rows: unknown[]): Record<string, unknown> {
  const query = {
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => query),
    for: vi.fn(() => Promise.resolve(rows)),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ): Promise<unknown> => Promise.resolve(rows).then(resolve, reject),
  };
  return query;
}
