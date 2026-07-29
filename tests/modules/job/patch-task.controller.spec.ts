/**
 * @fileoverview 验证浏览器 PatchTask HTTP 边界的幂等请求头，不覆盖 Service 业务编排。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../../src/modules/auth/auth.service.js";
import { PatchTaskController } from "../../../src/modules/job/job.controller.js";
import { PatchTaskArchiveService } from "../../../src/modules/job/patch-task-archive.service.js";
import type {
  CreatePatchTaskInput,
  PatchTaskArtifactDownloadView,
  PatchTaskArtifactView,
  PatchTaskDetailView,
  PatchTaskView,
} from "../../../src/modules/job/patch-task.contracts.js";
import { PatchTaskService } from "../../../src/modules/job/patch-task.service.js";

const input: CreatePatchTaskInput = {
  professionId: "11111111-1111-4111-8111-111111111111",
  styleId: "22222222-2222-4222-8222-222222222222",
};
const ownerUserId = "44444444-4444-4444-8444-444444444444";
const skillId = "77777777-7777-4777-8777-777777777777";
const task: PatchTaskView = {
  id: "33333333-3333-4333-8333-333333333333",
  professionName: "剑魂",
  styleName: "暗蓝幻影",
  status: "queued",
  progress: 0,
  createdAt: "2026-07-21T00:00:00.000Z",
  artifactAvailable: false,
};
const artifact: PatchTaskArtifactView = {
  artifactId: "55555555-5555-4555-8555-555555555555",
  role: "candidate",
  artifactName: "candidate.npk",
  mediaType: "application/octet-stream",
  byteLength: 200,
  sha256: "A".repeat(64),
};
const download: PatchTaskArtifactDownloadView = {
  ...artifact,
  downloadUrl: "http://127.0.0.1:9000/download",
  expiresAtUtc: "2026-07-25T12:05:00.000Z",
};
const detail: PatchTaskDetailView = {
  ...task,
  updatedAt: "2026-07-21T00:01:00.000Z",
  currentStage: "planning",
  totalSkills: 1,
  passedSkills: 0,
  workflow: [
    { key: "planning", status: "running" },
    { key: "skill-production", status: "pending" },
    { key: "package-validation", status: "pending" },
    { key: "complete", status: "pending" },
  ],
  skills: [],
  packageStatus: "queued",
  modelThroughput: {
    totalCalls: 0,
    egressCalls: 0,
    runningCalls: 0,
    measuredCalls: 0,
    successRate: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    averageOutputTokensPerSecond: null,
    averageProviderLatencyMs: null,
    groups: [],
    recentCalls: [],
  },
};
const referenceDownload = {
  artifactId: "88888888-8888-4888-8888-888888888888",
  skillId,
  artifactName: "reference.png",
  mediaType: "image/png" as const,
  byteLength: 512,
  sha256: "D".repeat(64),
  downloadUrl: "http://127.0.0.1:9000/reference",
  expiresAtUtc: "2026-07-28T00:05:00.000Z",
};

describe("PatchTaskController", () => {
  const create =
    vi.fn<
      (
        input: CreatePatchTaskInput,
        key: string,
        ownerUserId: string,
      ) => Promise<PatchTaskView>
    >();
  const requireBrowserUser = vi.fn();
  const archive = vi.fn().mockResolvedValue(undefined);
  const findDetail = vi.fn().mockResolvedValue(detail);
  const findArtifacts = vi.fn().mockResolvedValue([artifact]);
  const authorizeArtifactDownload = vi.fn().mockResolvedValue(download);
  const authorizeReferenceImageDownload = vi
    .fn()
    .mockResolvedValue(referenceDownload);
  const authorizeSkillPreviewDownload = vi
    .fn()
    .mockResolvedValue({ ...referenceDownload, role: "reference-image" });
  let controller: PatchTaskController;

  beforeEach(async () => {
    vi.resetAllMocks();
    create.mockResolvedValue(task);
    findDetail.mockResolvedValue(detail);
    findArtifacts.mockResolvedValue([artifact]);
    authorizeArtifactDownload.mockResolvedValue(download);
    authorizeReferenceImageDownload.mockResolvedValue(referenceDownload);
    authorizeSkillPreviewDownload.mockResolvedValue({
      ...referenceDownload,
      role: "reference-image",
    });
    archive.mockResolvedValue(undefined);
    requireBrowserUser.mockResolvedValue({ id: ownerUserId });
    const module = await Test.createTestingModule({
      providers: [
        {
          provide: PatchTaskService,
          useValue: {
            create,
            findDetail,
            findArtifacts,
            authorizeArtifactDownload,
            authorizeReferenceImageDownload,
            authorizeSkillPreviewDownload,
          },
        },
        { provide: PatchTaskArchiveService, useValue: { archive } },
        { provide: AuthService, useValue: { requireBrowserUser } },
        {
          provide: PatchTaskController,
          inject: [PatchTaskService, PatchTaskArchiveService, AuthService],
          useFactory: (
            patchTasks: PatchTaskService,
            patchTaskArchive: PatchTaskArchiveService,
            auth: AuthService,
          ): PatchTaskController =>
            new PatchTaskController(patchTasks, patchTaskArchive, auth),
        },
      ],
    }).compile();
    controller = module.get(PatchTaskController);
  });

  it.each([undefined, "", "contains spaces", "patch/"])(
    "rejects an invalid Idempotency-Key header: %s",
    (idempotencyKey) => {
      expect(() =>
        controller.create(idempotencyKey, "Bearer access", input),
      ).toThrow(BadRequestException);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("passes a valid Idempotency-Key to the task service unchanged", async () => {
    await expect(
      controller.create("patch.request-1", "Bearer access", input),
    ).resolves.toEqual({ data: task });
    expect(requireBrowserUser).toHaveBeenCalledWith("Bearer access");
    expect(create).toHaveBeenCalledWith(input, "patch.request-1", ownerUserId);
  });

  it("passes the authenticated owner to the three-artifact metadata query", async () => {
    await expect(
      controller.artifacts(task.id, "Bearer access"),
    ).resolves.toEqual({ data: [artifact] });
    expect(requireBrowserUser).toHaveBeenCalledWith("Bearer access");
    expect(findArtifacts).toHaveBeenCalledWith(task.id, ownerUserId);
  });

  it("passes the authenticated owner to the task detail query", async () => {
    await expect(controller.detail(task.id, "Bearer access")).resolves.toEqual({
      data: detail,
    });
    expect(requireBrowserUser).toHaveBeenCalledWith("Bearer access");
    expect(findDetail).toHaveBeenCalledWith(task.id, ownerUserId);
  });

  it("passes the authenticated owner to the soft archive command", async () => {
    await expect(
      controller.archive(task.id, "Bearer access"),
    ).resolves.toBeUndefined();
    expect(requireBrowserUser).toHaveBeenCalledWith("Bearer access");
    expect(archive).toHaveBeenCalledWith(task.id, ownerUserId);
  });

  it("authorizes a fixed role only after resolving the authenticated owner", async () => {
    await expect(
      controller.authorizeArtifactDownload(
        task.id,
        "candidate",
        "Bearer access",
      ),
    ).resolves.toEqual({ data: download });
    expect(requireBrowserUser).toHaveBeenCalledWith("Bearer access");
    expect(authorizeArtifactDownload).toHaveBeenCalledWith(
      task.id,
      "candidate",
      ownerUserId,
    );
  });

  it("authorizes a reference image by task and skill after resolving the owner", async () => {
    await expect(
      controller.authorizeReferenceImageDownload(
        task.id,
        skillId,
        "Bearer access",
      ),
    ).resolves.toEqual({ data: referenceDownload });
    expect(requireBrowserUser).toHaveBeenCalledWith("Bearer access");
    expect(authorizeReferenceImageDownload).toHaveBeenCalledWith(
      task.id,
      skillId,
      ownerUserId,
    );
  });

  it("authorizes a fixed skill preview role after resolving the owner", async () => {
    await expect(
      controller.authorizeSkillPreviewDownload(
        task.id,
        skillId,
        "reference-image",
        "Bearer access",
      ),
    ).resolves.toEqual({
      data: { ...referenceDownload, role: "reference-image" },
    });
    expect(authorizeSkillPreviewDownload).toHaveBeenCalledWith(
      task.id,
      skillId,
      "reference-image",
      ownerUserId,
    );
  });
});
