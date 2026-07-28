/**
 * @fileoverview 验证 PatchTaskService 将 Worker 回填和租约上下文结果映射为稳定 HTTP 契约。
 * @module job
 * @author AI生成
 * @created 2026-07-26
 * @relatedPlan N/A - PatchTaskService 测试职责拆分
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PatchTaskService } from "./patch-task.service.js";

const professionId = "11111111-1111-4111-8111-111111111111";
const styleId = "22222222-2222-4222-8222-222222222222";
const sourceRunId = "55555555-5555-4555-8555-555555555555";

describe("PatchTaskService worker-facing execution", () => {
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
  let service: PatchTaskService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new PatchTaskService(
      patchTasks,
      { getStyleBuildContext: vi.fn() },
      { get: vi.fn() },
      { get: vi.fn() },
      { create: vi.fn(), blockDeferredDispatch: vi.fn() },
      { hasEnabledCapability: vi.fn() },
      { authorizeRunArtifactDownload: vi.fn() },
      { get: vi.fn() },
    );
  });

  it("accepts worker skill and package evidence reports", async () => {
    patchTasks.reportSkillProduction.mockResolvedValue({ status: "accepted" });
    patchTasks.reportPackage.mockResolvedValue({ status: "accepted" });

    await expect(
      service.reportSkillProduction("job-id", {
        workerId: crypto.randomUUID(),
        leaseId: crypto.randomUUID(),
        attempt: 2,
        skillId: crypto.randomUUID(),
        status: "generating",
      }),
    ).resolves.toBeUndefined();
    await expect(
      service.reportPackage("job-id", {
        workerId: crypto.randomUUID(),
        leaseId: crypto.randomUUID(),
        attempt: 2,
        status: "building",
      }),
    ).resolves.toBeUndefined();
  });

  it("maps worker report conflicts and missing records to stable HTTP errors", async () => {
    patchTasks.reportSkillProduction.mockResolvedValue({
      status: "model-execution-evidence-mismatch",
    });
    await expect(
      service.reportSkillProduction("job-id", {
        workerId: crypto.randomUUID(),
        leaseId: crypto.randomUUID(),
        attempt: 2,
        skillId: crypto.randomUUID(),
        status: "passed",
        asepriteBinarySha256: "A".repeat(64),
        asepriteAdapterSha256: "B".repeat(64),
        asepriteArtifactId: crypto.randomUUID(),
        validationArtifactId: crypto.randomUUID(),
        sourcePreviewArtifactId: crypto.randomUUID(),
        resultPreviewArtifactId: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    patchTasks.reportPackage.mockResolvedValue({ status: "package-not-found" });
    await expect(
      service.reportPackage("job-id", {
        workerId: crypto.randomUUID(),
        leaseId: crypto.randomUUID(),
        attempt: 2,
        status: "building",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns only the lease-gated frozen Profession context", async () => {
    const context = {
      runId: sourceRunId,
      profileId: "profile-v2",
      professionId,
      styleId,
      themeDefinition: {
        schemaVersion: 1 as const,
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
      skill: { skillId: crypto.randomUUID() },
    };
    patchTasks.resolveProfessionSkillExecution.mockResolvedValue({
      status: "accepted",
      context,
    });
    const input = {
      workerId: crypto.randomUUID(),
      leaseId: crypto.randomUUID(),
      attempt: 2,
      skillId: context.skill.skillId,
    };

    await expect(
      service.resolveProfessionSkillExecution("job-id", input),
    ).resolves.toBe(context);
    expect(patchTasks.resolveProfessionSkillExecution).toHaveBeenCalledWith(
      "job-id",
      input,
    );
  });

  it.each([
    ["lease-mismatch", ConflictException, "JOB_LEASE_MISMATCH"],
    ["job-kind-mismatch", ConflictException, "PATCH_TASK_JOB_KIND_REQUIRED"],
    [
      "job-integrity-failed",
      ConflictException,
      "PROFESSION_JOB_INTEGRITY_FAILED",
    ],
    ["skill-not-found", NotFoundException, "PROFESSION_JOB_SKILL_NOT_FOUND"],
  ] as const)(
    "maps Profession execution %s to a stable internal error",
    async (status, exceptionType, code) => {
      patchTasks.resolveProfessionSkillExecution.mockResolvedValue({ status });

      const error: unknown = await service
        .resolveProfessionSkillExecution("job-id", {
          workerId: crypto.randomUUID(),
          leaseId: crypto.randomUUID(),
          attempt: 2,
          skillId: crypto.randomUUID(),
        })
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(exceptionType);
      if (
        !(
          error instanceof ConflictException ||
          error instanceof NotFoundException
        )
      ) {
        throw error;
      }
      expect(error.getResponse()).toMatchObject({ code });
    },
  );

  it("returns Server-derived Profession production progress", async () => {
    const input = {
      workerId: crypto.randomUUID(),
      leaseId: crypto.randomUUID(),
      attempt: 2,
    };
    const progress = {
      schemaVersion: 1 as const,
      skills: [{ skillId: crypto.randomUUID(), status: "pending" as const }],
    };
    patchTasks.resolveProfessionProductionProgress.mockResolvedValue({
      status: "accepted",
      progress,
    });

    await expect(
      service.resolveProfessionProductionProgress("job-id", input),
    ).resolves.toEqual(progress);
    expect(patchTasks.resolveProfessionProductionProgress).toHaveBeenCalledWith(
      "job-id",
      input,
    );
  });

  it("maps Profession progress integrity failure to a stable conflict", async () => {
    patchTasks.resolveProfessionProductionProgress.mockResolvedValue({
      status: "production-integrity-failed",
    });

    const error: unknown = await service
      .resolveProfessionProductionProgress("job-id", {
        workerId: crypto.randomUUID(),
        leaseId: crypto.randomUUID(),
        attempt: 2,
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw error;
    expect(error.getResponse()).toMatchObject({
      code: "PROFESSION_PRODUCTION_EVIDENCE_MISMATCH",
    });
  });
});
