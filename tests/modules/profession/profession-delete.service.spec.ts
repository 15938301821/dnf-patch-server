/**
 * @fileoverview 验证职业删除 Repository 结果到稳定 HTTP 语义的映射；不连接真实 MySQL。
 * @module profession
 * @author AI生成
 * @created 2026-07-29
 * @relatedPlan N/A（用户直接需求：职业列表增加删除功能）
 *
 * Mock Repository 只替代删除事务结果；本测试证明用户 ID 传递及 404/409 映射，不证明真实行锁、
 * 外键或事务回滚。受保护职业必须保持失败，不能被当作删除成功。
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfessionService } from "../../../src/modules/profession/profession.service.js";

const professionId = "11111111-1111-4111-8111-111111111111";
const ownerUserId = "22222222-2222-4222-8222-222222222222";

describe("ProfessionService profession deletion", () => {
  const professions = { delete: vi.fn() };
  let service: ProfessionService;

  beforeEach(() => {
    vi.resetAllMocks();
    professions.delete.mockResolvedValue("deleted");
    service = new ProfessionService(
      professions as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it("deletes an owned empty profession and forwards the stable owner", async () => {
    await expect(
      service.delete(professionId, ownerUserId),
    ).resolves.toBeUndefined();
    expect(professions.delete).toHaveBeenCalledWith(professionId, ownerUserId);
  });

  it("rejects a profession with protected status or content", async () => {
    professions.delete.mockResolvedValue("protected");

    const error = await service
      .delete(professionId, ownerUserId)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw error;
    expect(error.getResponse()).toMatchObject({
      code: "PROFESSION_DELETE_NOT_ALLOWED",
    });
  });

  it("hides a missing or foreign profession", async () => {
    professions.delete.mockResolvedValue("not-found");

    const error = await service
      .delete(professionId, ownerUserId)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(NotFoundException);
    if (!(error instanceof NotFoundException)) throw error;
    expect(error.getResponse()).toMatchObject({ code: "PROFESSION_NOT_FOUND" });
  });
});
