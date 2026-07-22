/**
 * @fileoverview 验证浏览器制作任务只创建声明式 Run 和计划记录，不执行本机工具。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import { PatchTaskService } from "./patch-task.service.js";
import type { StyleBuildContext } from "../profession/profession.contracts.js";
import { createRunSchema } from "../run/run.contracts.js";
import { styleSkillProductionJobPayloadV2Schema } from "./style-skill-production.contracts.js";

const professionId = "11111111-1111-4111-8111-111111111111";
const styleId = "22222222-2222-4222-8222-222222222222";
const workflowProjectId = "33333333-3333-4333-8333-333333333333";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const sourceRunId = "55555555-5555-4555-8555-555555555555";
const idempotencyKey = "patch.test-request";
const ownerUserId = "99999999-9999-4999-8999-999999999999";

describe("PatchTaskService", () => {
  const patchTasks = {
    list: vi.fn(),
    createPlan: vi.fn(),
    findArtifact: vi.fn(),
    reportSkillProduction: vi.fn(),
    reportPackage: vi.fn(),
  };
  const professions = { getStyleBuildContext: vi.fn() };
  const factories = { get: vi.fn() };
  const projects = { get: vi.fn() };
  const runs = { create: vi.fn(), blockDeferredDispatch: vi.fn() };
  let service: PatchTaskService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new PatchTaskService(
      patchTasks,
      professions,
      factories,
      projects,
      runs,
    );
    professions.getStyleBuildContext.mockResolvedValue(buildContext());
    projects.get.mockResolvedValue({
      id: workflowProjectId,
      factoryId: "factory-v2",
    });
    factories.get.mockResolvedValue({
      config: {
        schemaVersion: 2,
        profileId: "profile-v2",
        policyId: "policy-v2",
        policySha256: "A".repeat(64),
      },
    });
    runs.create.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      createdAtUtc: "2026-07-21T00:00:00.000Z",
    });
    runs.blockDeferredDispatch.mockResolvedValue(undefined);
  });

  it("creates one guarded profession job and planned skill productions", async () => {
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
        jobs: [expect.objectContaining({ kind: "profession" })],
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
    const frozenSkill = payload.parameters.promptPackage.skills[0];
    if (!frozenSkill) throw new Error("TEST_SKILL_REQUIRED");
    expect(createInput.clientRunId).toMatch(/^patch\.[A-F0-9]{64}$/u);
    expect(payload.parameters).toMatchObject({
      workflow: "style-skill-production-v2",
      selectedSkillIds: ["77777777-7777-4777-8777-777777777777"],
      deploymentAuthorized: false,
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

  it("accepts worker skill and package evidence reports", async () => {
    patchTasks.reportSkillProduction.mockResolvedValue({ status: "accepted" });
    patchTasks.reportPackage.mockResolvedValue({ status: "accepted" });

    await expect(
      service.reportSkillProduction("job-id", {
        workerId: crypto.randomUUID(),
        skillId: crypto.randomUUID(),
        status: "generating",
      }),
    ).resolves.toBeUndefined();
    await expect(
      service.reportPackage("job-id", {
        workerId: crypto.randomUUID(),
        status: "building",
      }),
    ).resolves.toBeUndefined();
  });

  it("maps worker report conflicts and missing records to stable HTTP errors", async () => {
    patchTasks.reportSkillProduction.mockResolvedValue({
      status: "model-call-not-passed",
    });
    await expect(
      service.reportSkillProduction("job-id", {
        workerId: crypto.randomUUID(),
        skillId: crypto.randomUUID(),
        status: "passed",
        modelCallId: crypto.randomUUID(),
        imageAttemptId: crypto.randomUUID(),
        asepriteProfileId: "aseprite-cli",
        asepriteBinarySha256: "A".repeat(64),
        asepriteArtifactId: crypto.randomUUID(),
        validationArtifactId: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    patchTasks.reportPackage.mockResolvedValue({ status: "package-not-found" });
    await expect(
      service.reportPackage("job-id", {
        workerId: crypto.randomUUID(),
        status: "building",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
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
        sourceFrameManifestArtifactId: "88888888-8888-4888-8888-888888888888",
        sourceMetadataSha256: "B".repeat(64),
      },
    ],
    missingProfessionPromptSkillIds: [],
  };
}
