/**
 * @fileoverview 验证 npk-package Job complete 必须依赖当前 attempt 已封存的 V3 输出证据；不启动 Nest、
 * 不连接 MySQL、不读取对象正文。
 * @module modules/job/job-style-package-completion-repository-support-spec
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 报告接收与 attempt 证据持久化
 *
 * Mock 边界：事务查询链用最小 fake 覆盖 select/update 调用；测试只证明 guard 的 fail-closed 决策和
 * 聚合写入字段，不能替代 migration 外键/check 约束或真实 Drizzle runtime smoke。
 */
import { describe, expect, it, vi } from "vitest";
import type { jobs } from "../../common/db/schema.js";
import { prepareStylePackageCompletion } from "./job-style-package-completion.repository-support.js";
import type { CompleteJobInput } from "./job.contracts.js";
import type { JobTransaction } from "./job-run-event.repository-support.js";

const now = new Date("2026-01-02T03:04:05.000Z");
const validationSha256 = "A".repeat(64);
const job = {
  id: "00000000-0000-4000-8000-000000000001",
  runId: "00000000-0000-4000-8000-000000000002",
  kind: "npk-package",
  attemptCount: 3,
} as typeof jobs.$inferSelect;
const input: CompleteJobInput = {
  workerId: "00000000-0000-4000-8000-000000000003",
  leaseId: "00000000-0000-4000-8000-000000000004",
  status: "passed",
  resultSha256: validationSha256.toLowerCase(),
};

function createTransaction(evidence: unknown[]): {
  transaction: JobTransaction;
  updates: unknown[];
} {
  const updates: unknown[] = [];
  const selectLimit = vi
    .fn()
    .mockReturnValue({ for: vi.fn().mockResolvedValue(evidence) });
  const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit });
  const transaction = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: selectWhere }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn((value: unknown) => {
        updates.push(value);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
  } as unknown as JobTransaction;
  return { transaction, updates };
}

describe("prepareStylePackageCompletion", () => {
  it("rejects passed npk-package completion without sealed attempt evidence", async () => {
    const { transaction } = createTransaction([]);

    await expect(
      prepareStylePackageCompletion(transaction, job, input, now),
    ).resolves.toEqual({
      status: "evidence-incomplete",
    });
  });

  it("accepts sealed passed evidence and updates the aggregate package row", async () => {
    const { transaction, updates } = createTransaction([
      {
        status: "passed",
        packageArtifactId: "00000000-0000-4000-8000-000000000005",
        manifestSha256: "B".repeat(64).toLowerCase(),
        validationSha256: validationSha256.toLowerCase(),
      },
    ]);

    await expect(
      prepareStylePackageCompletion(transaction, job, input, now),
    ).resolves.toEqual({
      status: "accepted",
      resultSha256: validationSha256,
    });
    expect(updates).toContainEqual({
      status: "passed",
      packageArtifactId: "00000000-0000-4000-8000-000000000005",
      manifestSha256: "B".repeat(64),
      updatedAt: now,
      finishedAt: now,
    });
  });

  it("closes a package that fails before its first building report", async () => {
    const { transaction, updates } = createTransaction([]);

    await expect(
      prepareStylePackageCompletion(
        transaction,
        job,
        { ...input, status: "failed", resultSha256: undefined },
        now,
      ),
    ).resolves.toEqual({ status: "accepted" });
    expect(updates).toEqual([
      { status: "failed", updatedAt: now, finishedAt: now },
    ]);
  });
});
