/**
 * @fileoverview 验证浏览器职业 API 将稳定用户身份传入所有个人内容操作；不访问数据库。
 * @module profession
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan N/A（对应当前个人职业与风格业务隔离需求）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveProfessionStyleInput } from "../../../src/modules/profession/profession.contracts.js";
import { ProfessionController } from "../../../src/modules/profession/profession.controller.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const professionId = "22222222-2222-4222-8222-222222222222";
const styleId = "33333333-3333-4333-8333-333333333333";

describe("ProfessionController", () => {
  const professions = {
    list: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    listSkills: vi.fn(),
    listStyles: vi.fn(),
    createStyle: vi.fn(),
    updateStyle: vi.fn(),
    deleteStyle: vi.fn(),
    submitStyleForReview: vi.fn(),
  };
  const auth = { requireBrowserUser: vi.fn() };
  let controller: ProfessionController;

  beforeEach(() => {
    vi.resetAllMocks();
    auth.requireBrowserUser.mockResolvedValue({ id: ownerUserId });
    professions.list.mockResolvedValue([]);
    professions.create.mockResolvedValue({});
    professions.delete.mockResolvedValue(undefined);
    professions.listSkills.mockResolvedValue([]);
    professions.listStyles.mockResolvedValue([]);
    professions.createStyle.mockResolvedValue({});
    professions.updateStyle.mockResolvedValue({});
    professions.deleteStyle.mockResolvedValue(undefined);
    professions.submitStyleForReview.mockResolvedValue({});
    controller = new ProfessionController(professions as never, auth as never);
  });

  it("scopes every browser profession operation to the access-token user", async () => {
    const authorization = "Bearer browser-access";
    const professionInput = { name: "剑魂", slug: "sword-soul" };
    const styleInput = emptyStyle();

    await controller.list(authorization);
    await controller.create(authorization, professionInput);
    await controller.delete(authorization, professionId);
    await controller.listSkills(authorization, professionId);
    await controller.listStyles(authorization, professionId);
    await controller.createStyle(authorization, professionId, styleInput);
    await controller.updateStyle(
      authorization,
      professionId,
      styleId,
      styleInput,
    );
    await controller.deleteStyle(authorization, professionId, styleId);
    await controller.submitStyleForReview(authorization, professionId, styleId);

    expect(auth.requireBrowserUser).toHaveBeenCalledTimes(9);
    expect(professions.list).toHaveBeenCalledWith(ownerUserId);
    expect(professions.create).toHaveBeenCalledWith(
      professionInput,
      ownerUserId,
    );
    expect(professions.delete).toHaveBeenCalledWith(professionId, ownerUserId);
    expect(professions.listSkills).toHaveBeenCalledWith(
      professionId,
      ownerUserId,
    );
    expect(professions.listStyles).toHaveBeenCalledWith(
      professionId,
      ownerUserId,
    );
    expect(professions.createStyle).toHaveBeenCalledWith(
      professionId,
      styleInput,
      ownerUserId,
    );
    expect(professions.updateStyle).toHaveBeenCalledWith(
      professionId,
      styleId,
      styleInput,
      ownerUserId,
    );
    expect(professions.deleteStyle).toHaveBeenCalledWith(
      professionId,
      styleId,
      ownerUserId,
    );
    expect(professions.submitStyleForReview).toHaveBeenCalledWith(
      professionId,
      styleId,
      ownerUserId,
    );
  });
});

function emptyStyle(): SaveProfessionStyleInput {
  return {
    name: "暗蓝幻影",
    description: "",
    themeDefinition: {
      schemaVersion: 1,
      goal: "",
      baseStyle: "",
      colorAnchors: [],
      materialRules: "",
      particleRules: "",
      layeringRules: "",
      constraints: "",
      acceptanceCriteria: "",
      exclusions: "",
    },
    selectedSkillIds: [],
    skillPrompts: [],
  };
}
