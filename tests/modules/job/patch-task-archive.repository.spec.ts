/**
 * @fileoverview 验证制作任务软归档的事务分支与零删除边界；不连接真实 MySQL，也不证明行锁竞争语义。
 * @module modules/job/patch-task-archive-repository-spec
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan N/A - 用户直接需求：制作任务列表增加删除功能
 *
 * 调用关系：Vitest 用最小 Drizzle transaction stub 调用真实 PatchTaskRepository.archive。
 * 输入输出：stub 先执行无锁可见性查询，再按 Jobs -> Run 的锁顺序返回持久化行，断言稳定
 * archive 结果与 archivedAt 写入。
 * 副作用：仅记录内存中的 update 调用，不访问 MySQL、对象存储或 Worker。
 * 安全边界：活动状态、残留 lease、跨用户/不存在和重复归档都必须零写入；真实 migration、索引、
 * FOR UPDATE 互斥与限制性外键仍需真实 MySQL 验证。
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../../../src/common/db/database.service.js";
import { PatchTaskRepository } from "../../../src/modules/job/patch-task.repository.js";

const runId = "11111111-1111-4111-8111-111111111111";
const ownerUserId = "22222222-2222-4222-8222-222222222222";

interface ArchiveRunRow {
  id: string;
  status: string;
  archivedAt: Date | null;
}

interface ArchiveJobRow {
  status: string;
  leaseOwnerId: string | null;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
}

describe("PatchTaskRepository.archive", () => {
  it("archives a terminal task by writing only archivedAt", async () => {
    const harness = archiveHarness(terminalRun(), [terminalJob()]);

    await expect(harness.repository.archive(runId, ownerUserId)).resolves.toBe(
      "archived",
    );

    expect(harness.transaction).toHaveBeenCalledOnce();
    expect(harness.runForUpdate).toHaveBeenCalledWith("update");
    expect(harness.jobForUpdate).toHaveBeenCalledWith("update");
    expect(harness.updated).toHaveLength(1);
    expect(Object.keys(harness.updated[0] ?? {})).toEqual(["archivedAt"]);
    expect(harness.updated[0]?.archivedAt).toBeInstanceOf(Date);
  });

  it("rejects a queued Job without writing the Run", async () => {
    const harness = archiveHarness(terminalRun(), [
      { ...terminalJob(), status: "queued" },
    ]);

    await expect(harness.repository.archive(runId, ownerUserId)).resolves.toBe(
      "active",
    );
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("rejects residual lease evidence even when statuses look terminal", async () => {
    const harness = archiveHarness(terminalRun(), [
      {
        ...terminalJob(),
        leaseId: "33333333-3333-4333-8333-333333333333",
      },
    ]);

    await expect(harness.repository.archive(runId, ownerUserId)).resolves.toBe(
      "active",
    );
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("treats an already archived task as idempotent without locking Jobs", async () => {
    const harness = archiveHarness(
      { ...terminalRun(), archivedAt: new Date("2026-07-28T00:00:00.000Z") },
      [terminalJob()],
    );

    await expect(harness.repository.archive(runId, ownerUserId)).resolves.toBe(
      "archived",
    );
    expect(harness.select).toHaveBeenCalledOnce();
    expect(harness.jobForUpdate).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("hides missing or non-owned tasks behind not-found with zero writes", async () => {
    const harness = archiveHarness(undefined, []);

    await expect(harness.repository.archive(runId, ownerUserId)).resolves.toBe(
      "not-found",
    );
    expect(harness.select).toHaveBeenCalledOnce();
    expect(harness.update).not.toHaveBeenCalled();
  });
});

function terminalRun(): ArchiveRunRow {
  return { id: runId, status: "passed", archivedAt: null };
}

function terminalJob(): ArchiveJobRow {
  return {
    status: "passed",
    leaseOwnerId: null,
    leaseId: null,
    leaseExpiresAt: null,
  };
}

/** 按“只读 Run -> 锁 Jobs -> 锁 Run”顺序提供行，并只记录可能发生的 archivedAt update。 */
function archiveHarness(
  run: ArchiveRunRow | undefined,
  jobs: ArchiveJobRow[],
): {
  repository: PatchTaskRepository;
  transaction: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  runForUpdate: ReturnType<typeof vi.fn>;
  jobForUpdate: ReturnType<typeof vi.fn>;
  updated: Record<string, unknown>[];
} {
  const runForUpdate = vi.fn().mockResolvedValue(run ? [run] : []);
  const jobForUpdate = vi.fn().mockResolvedValue(jobs);
  let selectIndex = 0;
  const select = vi.fn(() => {
    selectIndex += 1;
    if (selectIndex === 1) {
      return {
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue(run ? [run] : []),
            })),
          })),
        })),
      };
    }
    if (selectIndex === 2) {
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({ for: jobForUpdate })),
          })),
        })),
      };
    }
    return {
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: runForUpdate })),
          })),
        })),
      })),
    };
  });
  const updated: Record<string, unknown>[] = [];
  const update = vi.fn(() => ({
    set: vi.fn((value: Record<string, unknown>) => ({
      where: vi.fn(() => {
        updated.push(value);
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
  const connection = {
    database: { transaction },
  } as unknown as DatabaseService;
  return {
    repository: new PatchTaskRepository(connection),
    transaction,
    select,
    update,
    runForUpdate,
    jobForUpdate,
    updated,
  };
}
