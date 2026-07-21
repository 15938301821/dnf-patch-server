/**
 * @fileoverview 验证浏览器制作任务只创建声明式 Run 和计划记录，不执行本机工具。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PatchTaskService } from "./patch-task.service.js";
import type { StyleBuildContext } from "../profession/profession.contracts.js";

const professionId = "11111111-1111-4111-8111-111111111111";
const styleId = "22222222-2222-4222-8222-222222222222";
const workflowProjectId = "33333333-3333-4333-8333-333333333333";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const sourceRunId = "55555555-5555-4555-8555-555555555555";

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
  const runs = { create: vi.fn() };
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
  });

  it("creates one guarded profession job and planned skill productions", async () => {
    await expect(
      service.create({ professionId, styleId }),
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
      expect.stringMatching(/^patch\./u),
    );
    expect(patchTasks.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({ professionId, styleId }),
      [expect.objectContaining({ sourceRunId })],
    );
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
      service.create({ professionId, styleId }),
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
      agent: "keep source geometry",
      prompt: "deep cobalt slash",
      selectedSkillIds: ["77777777-7777-4777-8777-777777777777"],
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
        sourceRunId,
        sourceFrameManifestArtifactId: "88888888-8888-4888-8888-888888888888",
        sourceMetadataSha256: "B".repeat(64),
      },
    ],
  };
}
