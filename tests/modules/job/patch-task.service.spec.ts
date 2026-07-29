/**
 * @fileoverview 验证浏览器制作任务只创建声明式 Run 和计划记录，不执行本机工具。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256JcsV1 } from "../../../src/common/utils/canonical.js";
import { PatchTaskService } from "../../../src/modules/job/patch-task.service.js";
import type { StyleBuildContext } from "../../../src/modules/profession/profession.contracts.js";
import { createRunSchema } from "../../../src/modules/run/run.contracts.js";
import { styleSkillProductionJobPayloadV2Schema } from "../../../src/modules/job/style-skill-production.contracts.js";
import { stylePackageProductionJobPayloadV3Schema } from "../../../src/modules/job/style-package-production.contracts.js";

const professionId = "11111111-1111-4111-8111-111111111111";
const styleId = "22222222-2222-4222-8222-222222222222";
const workflowProjectId = "33333333-3333-4333-8333-333333333333";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const sourceRunId = "55555555-5555-4555-8555-555555555555";
const idempotencyKey = "patch.test-request";
const ownerUserId = "99999999-9999-4999-8999-999999999999";
const packageEnvironment: Record<string, string> = {
  STYLE_PACKAGE_PROFILE_ID: "npk-package-v3",
  STYLE_PACKAGE_PACKAGER_TOOL_ID: "npk-packager-v1",
  STYLE_PACKAGE_PACKAGER_SHA256: "1".repeat(64),
  STYLE_PACKAGE_VALIDATOR_TOOL_ID: "npk-validator-v1",
  STYLE_PACKAGE_VALIDATOR_SHA256: "2".repeat(64),
  STYLE_PACKAGE_DIRECTXTEX_TOOL_ID: "directxtex-v1",
  STYLE_PACKAGE_TEXCONV_SHA256: "3".repeat(64),
  STYLE_PACKAGE_TEXDIAG_SHA256: "4".repeat(64),
  STYLE_PACKAGE_EXTRACTORSHARP_TOOL_ID: "extractorsharp-v1",
  STYLE_PACKAGE_EXTRACTOR_CORE_SHA256: "5".repeat(64),
  STYLE_PACKAGE_EXTRACTOR_JSON_SHA256: "6".repeat(64),
  STYLE_PACKAGE_EXTRACTOR_ZLIB_SHA256: "7".repeat(64),
};

describe("PatchTaskService", () => {
  const patchTasks = {
    list: vi.fn(),
    findDetail: vi.fn(),
    findReferenceImage: vi.fn(),
    findSkillPreview: vi.fn(),
    createPlan: vi.fn(),
    findArtifact: vi.fn(),
    findArtifacts: vi.fn(),
    reportSkillProduction: vi.fn(),
    reportPackage: vi.fn(),
    resolveProfessionSkillExecution: vi.fn(),
    resolveProfessionProductionProgress: vi.fn(),
  };
  const professions = { getStyleBuildContext: vi.fn() };
  const factories = { get: vi.fn() };
  const projects = { get: vi.fn() };
  const runs = { create: vi.fn(), blockDeferredDispatch: vi.fn() };
  const workers = { hasEnabledCapability: vi.fn() };
  const artifacts = { authorizeRunArtifactDownload: vi.fn() };
  const packageConfig = {
    get: vi.fn((key: string) => packageEnvironment[key]),
  };
  let service: PatchTaskService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new PatchTaskService(
      patchTasks,
      professions,
      factories,
      projects,
      runs,
      workers,
      artifacts,
      packageConfig,
    );
    professions.getStyleBuildContext.mockResolvedValue(buildContext());
    projects.get.mockResolvedValue({
      id: workflowProjectId,
      factoryId: "factory-v2",
    });
    factories.get.mockResolvedValue({
      config: {
        schemaVersion: 3,
        policyId: "policy-v3",
        policySha256: "A".repeat(64),
        allowedJobKinds: ["profession", "npk-package"],
        jobContracts: [
          {
            kind: "profession",
            schemaVersion: 1,
            profileId: "aseprite-production-v1",
          },
          {
            kind: "npk-package",
            schemaVersion: 1,
            profileId: "npk-package-v3",
          },
        ],
      },
    });
    runs.create.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      createdAtUtc: "2026-07-21T00:00:00.000Z",
    });
    runs.blockDeferredDispatch.mockResolvedValue(undefined);
    workers.hasEnabledCapability.mockResolvedValue(true);
  });

  it("creates guarded profession and deferred package jobs with planned skills", async () => {
    await expect(
      service.create({ professionId, styleId }, idempotencyKey, ownerUserId),
    ).resolves.toMatchObject({
      professionName: "剑魂",
      styleName: "暗蓝幻影",
      status: "queued",
    });
    expect(runs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: workflowProjectId,
        snapshotId,
        action: "generate-patch",
        jobs: [
          expect.objectContaining({ kind: "profession" }),
          expect.objectContaining({ kind: "npk-package" }),
        ],
      }),
      idempotencyKey,
      { deferJobDispatch: true, ownerUserId },
    );
    expect(professions.getStyleBuildContext).toHaveBeenCalledWith(
      professionId,
      styleId,
      ownerUserId,
    );
    const createInput = createRunSchema.parse(
      runs.create.mock.calls[0]?.[0] as unknown,
    );
    const payload = styleSkillProductionJobPayloadV2Schema.parse(
      createInput.jobs[0]?.payload,
    );
    const packagePayload = stylePackageProductionJobPayloadV3Schema.parse(
      createInput.jobs[1]?.payload,
    );
    const frozenSkill = payload.parameters.promptPackage.skills[0];
    if (!frozenSkill) throw new Error("TEST_SKILL_REQUIRED");
    expect(createInput.clientRunId).toMatch(/^patch\.[A-F0-9]{64}$/u);
    expect(payload.parameters).toMatchObject({
      workflow: "style-skill-production-v2",
      selectedSkillIds: ["77777777-7777-4777-8777-777777777777"],
      deploymentAuthorized: false,
    });
    expect(packagePayload.parameters).toMatchObject({
      workflow: "style-package-production-v3",
      selectedSkillIds: ["77777777-7777-4777-8777-777777777777"],
      safety: {
        deploymentAuthorized: false,
        deploymentPerformed: false,
        fullSkillCoverageProven: false,
        clientCompatibilityProven: false,
      },
    });
    expect(frozenSkill).toMatchObject({
      professionPrompt: buildContext().skills[0]?.professionPrompt,
      skillThemePrompt: buildContext().style.skillPrompts[0],
      sourceEvidence: { sourceRunId },
    });
    expect(patchTasks.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({ professionId, styleId }),
      [
        expect.objectContaining({
          sourceRunId,
          promptSha256: frozenSkill.promptSha256,
        }),
      ],
      "dispatch",
    );
  });

  it("uses the Factory v3 profession contract profile for the frozen payload", async () => {
    factories.get.mockResolvedValue({
      config: {
        schemaVersion: 3,
        policyId: "policy-v3",
        policySha256: "B".repeat(64),
        allowedJobKinds: ["inventory", "profession", "npk-package"],
        jobContracts: [
          {
            kind: "inventory",
            schemaVersion: 1,
            profileId: "resource-profile",
          },
          {
            kind: "profession",
            schemaVersion: 1,
            profileId: "aseprite-production-v1",
          },
          {
            kind: "npk-package",
            schemaVersion: 1,
            profileId: "npk-package-v3",
          },
        ],
      },
    });

    await service.create(
      { professionId, styleId },
      idempotencyKey,
      ownerUserId,
    );

    const createInput = createRunSchema.parse(
      runs.create.mock.calls[0]?.[0] as unknown,
    );
    const payload = styleSkillProductionJobPayloadV2Schema.parse(
      createInput.jobs[0]?.payload,
    );
    expect(payload.profileId).toBe("aseprite-production-v1");
    expect(createInput.policyId).toBe("policy-v3");
  });

  it("persists an auditable blocked plan without dispatching it", async () => {
    runs.create.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      status: "blocked",
      createdAtUtc: "2026-07-21T00:00:00.000Z",
    });

    await expect(
      service.create({ professionId, styleId }, idempotencyKey, ownerUserId),
    ).resolves.toMatchObject({ status: "blocked" });
    expect(patchTasks.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({ professionId, styleId }),
      [expect.objectContaining({ sourceRunId })],
      "blocked",
    );
  });

  it("blocks a deferred Run when plan persistence fails", async () => {
    patchTasks.createPlan.mockRejectedValue(new Error("database failure"));

    const error: unknown = await service
      .create({ professionId, styleId }, idempotencyKey, ownerUserId)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    if (!(error instanceof ServiceUnavailableException)) throw error;
    expect(error.getResponse()).toMatchObject({
      code: "PATCH_TASK_PLAN_FAILED",
      runId: "66666666-6666-4666-8666-666666666666",
    });
    expect(runs.blockDeferredDispatch).toHaveBeenCalledWith(
      "66666666-6666-4666-8666-666666666666",
    );
  });

  it("reports an unresolved compensation without leaking the cause", async () => {
    patchTasks.createPlan.mockRejectedValue(new Error("database failure"));
    runs.blockDeferredDispatch.mockRejectedValue(new Error("database offline"));

    const error: unknown = await service
      .create({ professionId, styleId }, idempotencyKey, ownerUserId)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    if (!(error instanceof ServiceUnavailableException)) throw error;
    expect(error.getResponse()).toMatchObject({
      code: "PATCH_TASK_PLAN_COMPENSATION_FAILED",
      runId: "66666666-6666-4666-8666-666666666666",
    });
  });

  it("fails closed when the profession has no workflow project", async () => {
    professions.getStyleBuildContext.mockResolvedValue({
      ...buildContext(),
      profession: {
        ...buildContext().profession,
        workflowProjectId: undefined,
      },
    });
    await expect(
      service.create({ professionId, styleId }, idempotencyKey, ownerUserId),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(runs.create).not.toHaveBeenCalled();
  });

  it("fails closed when no enabled Worker has profession capability", async () => {
    workers.hasEnabledCapability.mockImplementation((capability: string) =>
      Promise.resolve(capability !== "profession"),
    );

    const error: unknown = await service
      .create({ professionId, styleId }, idempotencyKey, ownerUserId)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw error;
    expect(error.getResponse()).toMatchObject({
      code: "PROFESSION_WORKER_REQUIRED",
    });
    expect(workers.hasEnabledCapability).toHaveBeenCalledWith("profession");
    expect(runs.create).not.toHaveBeenCalled();
  });

  it("fails closed when the Factory has no package contract", async () => {
    factories.get.mockResolvedValue({
      config: {
        schemaVersion: 2,
        profileId: "profile-v2",
        policyId: "policy-v2",
        policySha256: "A".repeat(64),
        allowedJobKinds: ["profession"],
        jobContracts: [{ kind: "profession", schemaVersion: 1 }],
      },
    });

    const error: unknown = await service
      .create({ professionId, styleId }, idempotencyKey, ownerUserId)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw error;
    expect(error.getResponse()).toMatchObject({
      code: "STYLE_PACKAGE_CONTRACT_REQUIRED",
    });
    expect(runs.create).not.toHaveBeenCalled();
  });

  it("fails closed when no enabled Worker has package capability", async () => {
    workers.hasEnabledCapability.mockImplementation((capability: string) =>
      Promise.resolve(capability !== "npk-package"),
    );

    const error: unknown = await service
      .create({ professionId, styleId }, idempotencyKey, ownerUserId)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw error;
    expect(error.getResponse()).toMatchObject({
      code: "STYLE_PACKAGE_WORKER_REQUIRED",
    });
    expect(runs.create).not.toHaveBeenCalled();
  });

  it("fails closed when the fixed Package profile is not configured", async () => {
    packageConfig.get.mockReturnValueOnce(undefined);

    const error: unknown = await service
      .create({ professionId, styleId }, idempotencyKey, ownerUserId)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw error;
    expect(error.getResponse()).toMatchObject({
      code: "STYLE_PACKAGE_PROFILE_REQUIRED",
    });
    expect(runs.create).not.toHaveBeenCalled();
  });
});

function buildContext(): StyleBuildContext {
  const professionPrompt = {
    schemaVersion: 1 as const,
    stableSemantics: "保留技能身份",
    commonPrompt: "保持角色与武器轮廓",
    sourceConstraints: "只处理核验帧",
    stageAcceptance: "逐帧通过来源约束",
  };
  return {
    profession: {
      id: professionId,
      name: "剑魂",
      slug: "sword-soul",
      canonicalName: "剑魂",
      styleCount: 1,
      publishStatus: "private",
      workflowProjectId,
      catalogSnapshotId: snapshotId,
      updatedAt: "2026-07-21T00:00:00.000Z",
    },
    style: {
      id: styleId,
      professionId,
      name: "暗蓝幻影",
      description: "test",
      themeDefinition: {
        schemaVersion: 1,
        goal: "统一暗蓝剑气主题",
        baseStyle: "deep cobalt slash",
        colorAnchors: [{ name: "主色", value: "#123456" }],
        materialRules: "保留清晰剑气边缘",
        particleRules: "粒子跟随原动画节奏",
        layeringRules: "不改变源帧层级语义",
        constraints: "keep source geometry",
        acceptanceCriteria: "逐帧轮廓可辨识",
        exclusions: "不新增角色本体效果",
      },
      selectedSkillIds: ["77777777-7777-4777-8777-777777777777"],
      skillPrompts: [
        {
          skillId: "77777777-7777-4777-8777-777777777777",
          themePrompt: "暗蓝月牙剑气",
          changes: "替换剑气材质与粒子颜色",
          acceptanceCriteria: "动作时间轴与原技能一致",
          exclusions: "不修改命中范围",
        },
      ],
      publishStatus: "private",
      updatedAt: "2026-07-21T00:00:00.000Z",
    },
    skills: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        professionId,
        displayName: "里·鬼剑术",
        promptStatus: "reviewed",
        mappingStatus: "verified",
        executionStatus: "build-ready",
        professionPrompt,
        professionPromptSha256: sha256JcsV1(professionPrompt),
        sourceRunId,
        sourceInventoryId: "99999999-9999-4999-8999-999999999999",
        sourceFrameManifestArtifactId: "88888888-8888-4888-8888-888888888888",
        sourceEntries: [
          {
            sourceInventoryEntryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            sourceMetadataSha256: "B".repeat(64),
          },
        ],
      },
    ],
    missingProfessionPromptSkillIds: [],
  };
}
