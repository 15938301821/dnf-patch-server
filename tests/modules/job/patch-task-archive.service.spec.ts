/**
 * @fileoverview 验证制作任务归档领域结果到稳定 HTTP 异常的映射；不覆盖 Repository 的真实事务。
 * @module modules/job/patch-task-archive-service-spec
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan N/A - 用户直接需求：制作任务列表增加删除功能
 *
 * 调用关系：Vitest 以 Repository mock 调用真实 PatchTaskArchiveService。
 * 输入输出：mock 返回稳定领域结果，测试断言成功、404 与 409 响应；不连接 MySQL 或 Worker。
 * 安全边界：跨用户与不存在不得产生可枚举差异，活动任务冲突不得被映射为成功。
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PatchTaskArchiveService } from "../../../src/modules/job/patch-task-archive.service.js";

const runId = "11111111-1111-4111-8111-111111111111";
const ownerUserId = "22222222-2222-4222-8222-222222222222";

describe("PatchTaskArchiveService", () => {
  const archive = vi.fn();
  let service: PatchTaskArchiveService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new PatchTaskArchiveService({ archive });
  });

  it("accepts first and repeated terminal archives without a response body", async () => {
    archive.mockResolvedValue("archived");

    await expect(service.archive(runId, ownerUserId)).resolves.toBeUndefined();
    expect(archive).toHaveBeenCalledWith(runId, ownerUserId);
  });

  it("maps missing and non-owned tasks to the same stable 404", async () => {
    archive.mockResolvedValue("not-found");

    const error: unknown = await service
      .archive(runId, ownerUserId)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(NotFoundException);
    if (!(error instanceof NotFoundException)) throw error;
    expect(error.getResponse()).toMatchObject({ code: "PATCH_TASK_NOT_FOUND" });
  });

  it("maps active execution or lease state to a stable 409", async () => {
    archive.mockResolvedValue("active");

    const error: unknown = await service
      .archive(runId, ownerUserId)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw error;
    expect(error.getResponse()).toMatchObject({ code: "PATCH_TASK_ACTIVE" });
  });
});
