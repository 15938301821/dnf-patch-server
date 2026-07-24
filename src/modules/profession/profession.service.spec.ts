/**
 * @fileoverview 验证职业主题审核、制作门禁与目录上下文绑定；不访问数据库、对象存储或本机工具。
 * @module profession
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A（对应当前前后端结构化主题直接需求）
 */
import { ConflictException } from "@nestjs/common";
import { NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProfessionStyle,
  StyleBuildContext,
} from "./profession.contracts.js";
import { ProfessionService } from "./profession.service.js";

const professionId = "11111111-1111-4111-8111-111111111111";
const styleId = "22222222-2222-4222-8222-222222222222";
const skillId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const snapshotId = "55555555-5555-4555-8555-555555555555";
const ownerUserId = "88888888-8888-4888-8888-888888888888";

describe("ProfessionService style gates", () => {
  const professions = {
    list: vi.fn(),
    findById: vi.fn(),
    findOwnedById: vi.fn(),
    findStyle: vi.fn(),
    submitStyleForReview: vi.fn(),
    getBuildContext: vi.fn(),
    replaceSkillCatalog: vi.fn(),
  };
  const projects = {
    get: vi.fn(),
    getSnapshot: vi.fn(),
  };
  let service: ProfessionService;

  beforeEach(() => {
    vi.resetAllMocks();
    professions.findById.mockResolvedValue(profession());
    professions.findOwnedById.mockResolvedValue(profession());
    professions.list.mockResolvedValue([]);
    professions.findStyle.mockResolvedValue(completeStyle());
    professions.submitStyleForReview.mockResolvedValue({
      ...completeStyle(),
      publishStatus: "pending",
    });
    professions.getBuildContext.mockResolvedValue(buildContext());
    professions.replaceSkillCatalog.mockResolvedValue([]);
    projects.get.mockResolvedValue({});
    projects.getSnapshot.mockResolvedValue({});
    service = new ProfessionService(
      professions as never,
      projects as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it("scopes browser profession lists to the authenticated owner", async () => {
    await expect(service.list(ownerUserId)).resolves.toEqual([]);

    expect(professions.list).toHaveBeenCalledWith(ownerUserId);
  });

  it("hides another user's profession before reading its styles", async () => {
    professions.findOwnedById.mockResolvedValue(undefined);

    const error = await service
      .listStyles(professionId, ownerUserId)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(NotFoundException);
    if (!(error instanceof NotFoundException)) throw error;
    expect(error.getResponse()).toMatchObject({ code: "PROFESSION_NOT_FOUND" });
    expect(professions.findStyle).not.toHaveBeenCalled();
  });

  it("rejects incomplete review content before changing state", async () => {
    professions.findStyle.mockResolvedValue({
      ...completeStyle(),
      themeDefinition: { ...completeStyle().themeDefinition, goal: "" },
    });

    const error = await service
      .submitStyleForReview(professionId, styleId, ownerUserId)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw error;
    expect(error.getResponse()).toMatchObject({
      code: "STYLE_CONTENT_INCOMPLETE",
      reasons: ["theme-incomplete"],
    });
    expect(professions.submitStyleForReview).not.toHaveBeenCalled();
    expect(professions.findOwnedById).toHaveBeenCalledWith(
      professionId,
      ownerUserId,
    );
  });

  it("rejects incomplete content before returning a build context", async () => {
    professions.getBuildContext.mockResolvedValue({
      ...buildContext(),
      style: { ...completeStyle(), selectedSkillIds: [], skillPrompts: [] },
      skills: [],
    });

    const error = await service
      .getStyleBuildContext(professionId, styleId, ownerUserId)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw error;
    expect(error.getResponse()).toMatchObject({
      code: "STYLE_CONTENT_INCOMPLETE",
      reasons: ["skills-required"],
    });
    expect(professions.getBuildContext).toHaveBeenCalledWith(
      professionId,
      styleId,
      ownerUserId,
    );
  });

  it("reports missing profession prompts separately from resource evidence", async () => {
    professions.getBuildContext.mockResolvedValue({
      ...buildContext(),
      missingProfessionPromptSkillIds: [skillId],
      skills: [],
    });

    const error = await service
      .getStyleBuildContext(professionId, styleId, ownerUserId)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw error;
    expect(error.getResponse()).toMatchObject({
      code: "STYLE_PROFESSION_PROMPTS_REQUIRED",
      skillIds: [skillId],
    });
  });

  it("binds a profession to a verified Project/Snapshot and downgrades all skills", async () => {
    professions.replaceSkillCatalog.mockResolvedValue([
      { id: skillId, executionStatus: "draft-only" },
    ]);

    await expect(
      service.bindCatalogContext(professionId, {
        workflowProjectId: projectId,
        catalogSnapshotId: snapshotId,
      }),
    ).resolves.toMatchObject({
      professionId,
      workflowProjectId: projectId,
      catalogSnapshotId: snapshotId,
      skills: [{ id: skillId, executionStatus: "draft-only" }],
    });

    expect(projects.get).toHaveBeenCalledWith(projectId);
    expect(projects.getSnapshot).toHaveBeenCalledWith(projectId, snapshotId);
    expect(professions.replaceSkillCatalog).toHaveBeenCalledWith(
      professionId,
      projectId,
      snapshotId,
      [],
    );
  });

  it("rejects cross-project rebinding before querying the snapshot", async () => {
    const otherProjectId = "99999999-9999-4999-8999-999999999999";
    professions.findById.mockResolvedValue({
      ...profession(),
      workflowProjectId: otherProjectId,
    });

    const error = await service
      .bindCatalogContext(professionId, {
        workflowProjectId: projectId,
        catalogSnapshotId: snapshotId,
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw error;
    expect(error.getResponse()).toMatchObject({
      code: "PROFESSION_PROJECT_BINDING_CONFLICT",
    });
    expect(projects.getSnapshot).not.toHaveBeenCalled();
    expect(professions.replaceSkillCatalog).not.toHaveBeenCalled();
  });

  it("fails closed when the target project does not exist", async () => {
    // Service 把 ProjectService 异常原样上抛；禁止在 Project 不存在时执行技能目录替换。
    projects.get.mockRejectedValue(
      new NotFoundException({ code: "PROJECT_NOT_FOUND" }),
    );

    await expect(
      service.bindCatalogContext(professionId, {
        workflowProjectId: projectId,
        catalogSnapshotId: snapshotId,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(professions.replaceSkillCatalog).not.toHaveBeenCalled();
  });
});

function profession(): StyleBuildContext["profession"] {
  return {
    id: professionId,
    name: "剑魂",
    slug: "sword-soul",
    canonicalName: "剑魂",
    styleCount: 1,
    publishStatus: "private",
    workflowProjectId: "44444444-4444-4444-8444-444444444444",
    catalogSnapshotId: "55555555-5555-4555-8555-555555555555",
    updatedAt: "2026-07-23T00:00:00.000Z",
  };
}

function completeStyle(): ProfessionStyle {
  return {
    id: styleId,
    professionId,
    name: "暗蓝幻影",
    description: "test",
    themeDefinition: {
      schemaVersion: 1,
      goal: "统一暗蓝剑气主题",
      baseStyle: "深钴蓝剑气",
      colorAnchors: [{ name: "主色", value: "#123456" }],
      materialRules: "保留清晰剑气边缘",
      particleRules: "粒子跟随原动画节奏",
      layeringRules: "不改变源帧层级语义",
      constraints: "保持源几何与锚点",
      acceptanceCriteria: "逐帧轮廓可辨识",
      exclusions: "不新增角色本体效果",
    },
    selectedSkillIds: [skillId],
    skillPrompts: [
      {
        skillId,
        themePrompt: "暗蓝月牙剑气",
        changes: "替换剑气材质与粒子颜色",
        acceptanceCriteria: "动作时间轴与原技能一致",
        exclusions: "不修改命中范围",
      },
    ],
    publishStatus: "private",
    updatedAt: "2026-07-23T00:00:00.000Z",
  };
}

function buildContext(): StyleBuildContext {
  return {
    profession: profession(),
    style: completeStyle(),
    missingProfessionPromptSkillIds: [],
    skills: [
      {
        id: skillId,
        professionId,
        displayName: "里·鬼剑术",
        promptStatus: "reviewed",
        mappingStatus: "verified",
        executionStatus: "build-ready",
        professionPrompt: {
          schemaVersion: 1,
          stableSemantics: "保留技能身份",
          commonPrompt: "保持角色与武器轮廓",
          sourceConstraints: "只处理核验帧",
          stageAcceptance: "逐帧通过来源约束",
        },
        professionPromptSha256: "A".repeat(64),
        sourceRunId: "66666666-6666-4666-8666-666666666666",
        sourceFrameManifestArtifactId: "77777777-7777-4777-8777-777777777777",
        sourceMetadataSha256: "B".repeat(64),
      },
    ],
  };
}
