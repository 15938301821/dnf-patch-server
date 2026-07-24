/**
 * @fileoverview 验证 0019 单技能生产证据 migration 在新库、旧库和部分 DDL 状态下 fail-closed。
 * @module common/db/style-skill-production-migration-precheck-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：Vitest 注入仅返回 COUNT 的 mysql2 connection stub，调用真实只读预检函数。
 * 安全边界：本测试不连接 MySQL，也不证明真实 CHECK/外键执行语义；SQL 内容断言用于防止漏查
 * passed 与带 Job 的失败终态。
 */
import type { PoolConnection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { assertStyleSkillProductionEvidenceMigrationReady } from "./style-skill-production-migration-precheck.js";

describe("assertStyleSkillProductionEvidenceMigrationReady", () => {
  it("allows a new database without the production table", async () => {
    const harness = countQueryHarness(0);

    await expect(
      assertStyleSkillProductionEvidenceMigrationReady(harness.connection),
    ).resolves.toBeUndefined();

    expect(harness.query).toHaveBeenCalledTimes(1);
  });

  it("allows an old table when no incompatible terminal evidence exists", async () => {
    const harness = countQueryHarness(1, 0, 0, 0);

    await expect(
      assertStyleSkillProductionEvidenceMigrationReady(harness.connection),
    ).resolves.toBeUndefined();

    expect(harness.query).toHaveBeenCalledTimes(4);
    expect(harness.query.mock.calls[3]?.[0]).toContain("`status` = 'passed'");
    expect(harness.query.mock.calls[3]?.[0]).toContain(
      "`status` IN ('failed','blocked') AND `job_id` IS NOT NULL",
    );
  });

  it("allows a schema with every 0019 evidence marker", async () => {
    const harness = countQueryHarness(1, 7, 5);

    await expect(
      assertStyleSkillProductionEvidenceMigrationReady(harness.connection),
    ).resolves.toBeUndefined();

    expect(harness.query).toHaveBeenCalledTimes(3);
  });

  it("blocks an old terminal row whose missing evidence cannot be inferred", async () => {
    const harness = countQueryHarness(1, 0, 0, 1);

    await expect(
      assertStyleSkillProductionEvidenceMigrationReady(harness.connection),
    ).rejects.toThrow("STYLE_SKILL_PRODUCTION_EVIDENCE_MIGRATION_BLOCKED");
  });

  it.each([
    ["some evidence columns exist", 3, 0],
    ["a marker constraint is missing", 7, 4],
  ])(
    "blocks partial DDL when %s",
    async (_description, columns, constraints) => {
      const harness = countQueryHarness(1, columns, constraints);

      await expect(
        assertStyleSkillProductionEvidenceMigrationReady(harness.connection),
      ).rejects.toThrow("STYLE_SKILL_PRODUCTION_EVIDENCE_MIGRATION_PARTIAL");

      expect(harness.query).toHaveBeenCalledTimes(3);
    },
  );
});

function countQueryHarness(...counts: number[]): {
  connection: PoolConnection;
  query: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const query = vi.fn((statement: string) => {
    if (!statement.includes("COUNT")) {
      return Promise.reject(new Error("NON_READ_ONLY_PRECHECK_QUERY"));
    }
    const count = counts[index];
    index += 1;
    if (count === undefined) {
      return Promise.reject(new Error("UNEXPECTED_COUNT_QUERY"));
    }
    return Promise.resolve([[{ count }], []]);
  });
  return {
    connection: { query } as unknown as PoolConnection,
    query,
  };
}
