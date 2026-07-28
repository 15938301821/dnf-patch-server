/**
 * @fileoverview 验证任务技能参考图查询只接受唯一的当前 attempt passed PNG 投影；使用 Drizzle
 * 查询 stub，不连接真实 MySQL、对象存储或模型 Provider。
 * @module modules/job/patch-task-reference-image-repository-support-spec
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan /memories/session/plan.md - 制作任务详情与模型吞吐监控
 *
 * 测试证明 Repository 对零行和多行结果失败关闭，并保持固定 PNG ViewModel；SQL 中的用户、Run、
 * skill、attempt 与 stage 联接仍需隔离 MySQL 验证，stub 不能证明数据库执行计划或外键语义。
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../../common/db/database.service.js";
import { findPatchTaskReferenceImage } from "./patch-task-reference-image.repository-support.js";

const runId = "11111111-1111-4111-8111-111111111111";
const skillId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "33333333-3333-4333-8333-333333333333";
const image = {
  artifactId: "44444444-4444-4444-8444-444444444444",
  skillId,
  artifactName: "reference.png",
  mediaType: "image/png",
  byteLength: 512,
  sha256: "A".repeat(64),
};

describe("findPatchTaskReferenceImage", () => {
  it("returns the unique fixed PNG projection", async () => {
    await expect(
      findPatchTaskReferenceImage(
        databaseStub([image]),
        runId,
        skillId,
        ownerUserId,
      ),
    ).resolves.toEqual(image);
  });

  it("fails closed when no current evidence matches", async () => {
    await expect(
      findPatchTaskReferenceImage(
        databaseStub([]),
        runId,
        skillId,
        ownerUserId,
      ),
    ).resolves.toBeUndefined();
  });

  it("fails closed when duplicate passed evidence would make the role ambiguous", async () => {
    await expect(
      findPatchTaskReferenceImage(
        databaseStub([image, { ...image, artifactId: crypto.randomUUID() }]),
        runId,
        skillId,
        ownerUserId,
      ),
    ).resolves.toBeUndefined();
  });
});

function databaseStub(rows: unknown[]): DatabaseService {
  const query = {
    innerJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return {
    database: { select: vi.fn(() => ({ from: vi.fn(() => query) })) },
  } as unknown as DatabaseService;
}
