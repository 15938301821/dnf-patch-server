/**
 * @fileoverview 验证浏览器任务详情在 Run 所有权证据缺失时立即停止后续数据库读取。
 * @module modules/job/patch-task-detail-repository-support-spec
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan /memories/session/plan.md - 制作任务详情与模型吞吐监控
 *
 * 测试使用 Drizzle 查询 stub 替代 MySQL，只证明首个 owner-scoped 查询返回空后，不再读取技能、
 * 模型执行或 ModelCall 投影；不证明真实数据库索引、SQL 执行计划、外键或事务隔离语义。
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../../../src/common/db/database.service.js";
import { findPatchTaskDetail } from "../../../src/modules/job/patch-task-detail.repository-support.js";

const runId = "11111111-1111-4111-8111-111111111111";
const ownerUserId = "22222222-2222-4222-8222-222222222222";

describe("findPatchTaskDetail", () => {
  it("stops after the owner-scoped task query returns no row", async () => {
    // 首查询空结果同时覆盖任务不存在与跨用户访问；二者必须共享相同的低信息失败路径。
    const select = vi.fn(() => {
      const query = {
        innerJoin: vi.fn(() => query),
        leftJoin: vi.fn(() => query),
        where: vi.fn(() => query),
        limit: vi.fn().mockResolvedValue([]),
      };
      return { from: vi.fn(() => query) };
    });
    const connection = {
      database: { select },
    } as unknown as DatabaseService;

    await expect(
      findPatchTaskDetail(connection, runId, ownerUserId),
    ).resolves.toBeUndefined();
    expect(select).toHaveBeenCalledTimes(1);
  });
});
