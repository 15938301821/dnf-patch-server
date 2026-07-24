/**
 * @fileoverview 验证当前 V2 Profession Job 未冻结封包工具时拒绝全部 package 回填；
 * 不连接 MySQL、不读取对象正文，也不执行本机封包工具。
 * @module modules/job/patch-task-package-repository-spec
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - 整体真实数据巡检发现的 package 证据归属缺口
 *
 * 调用关系：Vitest 用最小 Drizzle transaction stub 调用真实 Repository；真实 MySQL 约束由
 * runtime 门禁另行覆盖。安全边界：Artifact 归属正确也不能替代缺失的封包器与验证器契约。
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../../common/db/database.service.js";
import type { ReportPatchTaskPackageInput } from "./patch-task.contracts.js";
import { PatchTaskRepository } from "./patch-task.repository.js";

const jobId = "00000000-0000-4000-8000-000000000000";
const runId = "11111111-1111-4111-8111-111111111111";
const workerId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const artifactId = "44444444-4444-4444-8444-444444444444";
const packageId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-07-25T00:00:00.000Z");

describe("PatchTaskRepository.reportPackage", () => {
  it("rejects a passed package even when the Worker supplies an Artifact", async () => {
    const harness = packageHarness();

    await expect(
      harness.repository.reportPackage(jobId, passedReport()),
    ).resolves.toEqual({ status: "package-capability-not-frozen" });

    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.forUpdate).toHaveBeenCalledTimes(2);
  });

  it("also rejects a building report because no package stage was frozen", async () => {
    const harness = packageHarness();

    await expect(
      harness.repository.reportPackage(jobId, {
        workerId,
        leaseId,
        attempt: 2,
        status: "building",
      }),
    ).resolves.toEqual({ status: "package-capability-not-frozen" });

    expect(harness.update).not.toHaveBeenCalled();
  });
});

interface PackageHarness {
  repository: PatchTaskRepository;
  update: ReturnType<typeof vi.fn>;
  updated: Record<string, unknown>[];
  forUpdate: ReturnType<typeof vi.fn>;
}

function passedReport(): ReportPatchTaskPackageInput {
  return {
    workerId,
    leaseId,
    attempt: 2,
    status: "passed" as const,
    packageArtifactId: artifactId,
    manifestSha256: "a".repeat(64),
  };
}

function packageHarness(): PackageHarness {
  const rows = [
    [
      {
        id: jobId,
        runId,
        kind: "profession",
        status: "leased",
        leaseOwnerId: workerId,
        leaseId,
        leaseExpiresAt: new Date("2026-07-25T00:01:00.000Z"),
        attemptCount: 2,
      },
    ],
    [{ value: now }],
    [{ id: packageId, runId, status: "building" }],
  ];
  let selectIndex = 0;
  const forUpdate = vi.fn();
  const select = vi.fn(() => {
    const selectedRows = rows[selectIndex] ?? [];
    selectIndex += 1;
    return {
      from: vi.fn(() => queryBuilder(selectedRows, forUpdate)),
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
    update,
    updated,
    forUpdate,
  };
}

function queryBuilder(
  rows: unknown[],
  forUpdate: (lock: string) => void,
): Record<string, unknown> {
  const query = {
    innerJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(() => query),
    for: vi.fn((lock: string) => {
      forUpdate(lock);
      return Promise.resolve(rows);
    }),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ): Promise<unknown> => Promise.resolve(rows).then(resolve, reject),
  };
  return query;
}
