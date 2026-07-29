/**
 * @fileoverview 验证职业风格删除结果到稳定 HTTP 语义的映射；不连接真实 MySQL 或执行物理删除。
 * @module profession
 * @author AI生成
 * @created 2026-07-29
 * @relatedPlan N/A（用户直接需求：职业风格增加删除功能）
 *
 * Mock Repository 只替代删除事务结果；本测试证明所有权参数传递和 404/409 映射，不证明行锁、
 * 限制性外键或真实 MySQL 回滚行为。受保护结果必须失败，不能被当作删除成功。
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfessionService } from "../../../src/modules/profession/profession.service.js";

const professionId = "11111111-1111-4111-8111-111111111111";
const styleId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "33333333-3333-4333-8333-333333333333";

describe("ProfessionService style deletion", () => {
  const professions = { deleteStyle: vi.fn() };
  let service: ProfessionService;

  beforeEach(() => {
    vi.resetAllMocks();
    professions.deleteStyle.mockResolvedValue("deleted");
    service = new ProfessionService(
      professions as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it("deletes an owned private draft and forwards the stable owner", async () => {
    await expect(
      service.deleteStyle(professionId, styleId, ownerUserId),
    ).resolves.toBeUndefined();

    expect(professions.deleteStyle).toHaveBeenCalledWith(
      professionId,
      styleId,
      ownerUserId,
    );
  });

  it("rejects protected styles without treating a failed delete as success", async () => {
    professions.deleteStyle.mockResolvedValue("protected");

    const error = await service
      .deleteStyle(professionId, styleId, ownerUserId)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw error;
    expect(error.getResponse()).toMatchObject({
      code: "STYLE_DELETE_NOT_ALLOWED",
    });
  });

  it("hides a missing or foreign style from the delete command", async () => {
    professions.deleteStyle.mockResolvedValue("not-found");

    const error = await service
      .deleteStyle(professionId, styleId, ownerUserId)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(NotFoundException);
    if (!(error instanceof NotFoundException)) throw error;
    expect(error.getResponse()).toMatchObject({ code: "STYLE_NOT_FOUND" });
  });
});
