/**
 * @fileoverview 验证浏览器制作任务详情与固定产物下载授权；不连接 MySQL 或对象存储。
 * @module modules/job/patch-task-access-service-spec
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan /memories/session/plan.md - 制作任务详情与模型吞吐监控
 *
 * 调用关系：测试直接调用 PatchTaskService 的浏览器读取方法，并以 Repository、Artifact Service
 * stub 替代真实数据库和私有对象存储。输入是稳定用户、Run、技能与固定产物角色，输出是脱敏
 * 详情或短期授权 ViewModel。副作用仅记录依赖调用；不证明真实所有权 SQL、对象签名或网络下载。
 * 安全边界：详情查询必须绑定 ownerUserId；参考图只按当前技能证据解析；缺失或跨用户证据必须
 * 共享低信息失败路径，且失败后不得请求对象存储签名。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PatchTaskService } from "../../../src/modules/job/patch-task.service.js";

const ownerUserId = "99999999-9999-4999-8999-999999999999";
const runId = "66666666-6666-4666-8666-666666666666";
const referenceSkillId = "88888888-8888-4888-8888-888888888888";

describe("PatchTaskService owner-scoped browser access", () => {
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
  const packageConfig = { get: vi.fn() };
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
  });

  it("returns only the owner-scoped task detail resolved by the repository", async () => {
    const taskDetail = {
      id: runId,
      professionName: "剑魂",
      styleName: "暗蓝幻影",
    };
    patchTasks.findDetail.mockResolvedValue(taskDetail);

    await expect(service.findDetail(runId, ownerUserId)).resolves.toBe(
      taskDetail,
    );
    expect(patchTasks.findDetail).toHaveBeenCalledWith(runId, ownerUserId);
  });

  it("maps missing and cross-user task details to the same not-found error", async () => {
    patchTasks.findDetail.mockResolvedValue(undefined);

    await expect(service.findDetail(runId, ownerUserId)).rejects.toMatchObject({
      response: { code: "PATCH_TASK_NOT_FOUND" },
    });
  });

  it("authorizes only the fixed reference image resolved for the owner and skill", async () => {
    const referenceImage = {
      artifactId: "77777777-7777-4777-8777-777777777777",
      skillId: referenceSkillId,
      artifactName: "reference.png",
      mediaType: "image/png" as const,
      byteLength: 512,
      sha256: "A".repeat(64),
    };
    patchTasks.findReferenceImage.mockResolvedValue(referenceImage);
    artifacts.authorizeRunArtifactDownload.mockResolvedValue({
      artifactId: referenceImage.artifactId,
      downloadUrl: "http://127.0.0.1:9000/reference",
      expiresAtUtc: "2026-07-28T00:05:00.000Z",
    });

    await expect(
      service.authorizeReferenceImageDownload(
        runId,
        referenceSkillId,
        ownerUserId,
      ),
    ).resolves.toMatchObject({
      ...referenceImage,
      downloadUrl: "http://127.0.0.1:9000/reference",
    });
    expect(patchTasks.findReferenceImage).toHaveBeenCalledWith(
      runId,
      referenceSkillId,
      ownerUserId,
    );
    expect(artifacts.authorizeRunArtifactDownload).toHaveBeenCalledWith(
      runId,
      referenceImage.artifactId,
      referenceImage.artifactName,
    );
  });

  it("does not sign object storage when owner-scoped reference evidence is missing", async () => {
    // 参考图不存在和跨用户访问必须共享失败路径，且不能把任意 Artifact ID 送到签名层。
    patchTasks.findReferenceImage.mockResolvedValue(undefined);

    await expect(
      service.authorizeReferenceImageDownload(
        runId,
        referenceSkillId,
        ownerUserId,
      ),
    ).rejects.toMatchObject({
      response: { code: "PATCH_TASK_REFERENCE_IMAGE_NOT_READY" },
    });
    expect(artifacts.authorizeRunArtifactDownload).not.toHaveBeenCalled();
  });

  it("authorizes only the requested fixed preview role", async () => {
    const preview = {
      artifactId: "12121212-1212-4212-8212-121212121212",
      skillId: referenceSkillId,
      role: "aseprite-result" as const,
      artifactName: "profession-aseprite-result-preview.png",
      mediaType: "image/png" as const,
      byteLength: 640,
      sha256: "B".repeat(64),
      frame: {
        entryIndex: 0,
        frameIndex: 3,
        internalPath: "sprite/effect/a.img",
        width: 16,
        height: 12,
        canvasWidth: 32,
        canvasHeight: 24,
        x: 2,
        y: -1,
      },
    };
    patchTasks.findSkillPreview.mockResolvedValue(preview);
    artifacts.authorizeRunArtifactDownload.mockResolvedValue({
      artifactId: preview.artifactId,
      downloadUrl: "http://127.0.0.1:9000/result",
      expiresAtUtc: "2026-07-28T00:05:00.000Z",
    });

    await expect(
      service.authorizeSkillPreviewDownload(
        runId,
        referenceSkillId,
        "aseprite-result",
        ownerUserId,
      ),
    ).resolves.toEqual({
      ...preview,
      downloadUrl: "http://127.0.0.1:9000/result",
      expiresAtUtc: "2026-07-28T00:05:00.000Z",
    });
    expect(patchTasks.findSkillPreview).toHaveBeenCalledWith(
      runId,
      referenceSkillId,
      "aseprite-result",
      ownerUserId,
    );
  });

  it("does not sign object storage when a fixed preview role is unavailable", async () => {
    patchTasks.findSkillPreview.mockResolvedValue(undefined);

    await expect(
      service.authorizeSkillPreviewDownload(
        runId,
        referenceSkillId,
        "source-frame",
        ownerUserId,
      ),
    ).rejects.toMatchObject({
      response: { code: "PATCH_TASK_SKILL_PREVIEW_NOT_READY" },
    });
    expect(artifacts.authorizeRunArtifactDownload).not.toHaveBeenCalled();
  });

  it("authorizes only a fixed role from the current owner's complete Package artifacts", async () => {
    const packageArtifacts = [
      {
        artifactId: crypto.randomUUID(),
        role: "candidate" as const,
        artifactName: "candidate.npk",
        mediaType: "application/octet-stream",
        byteLength: 200,
        sha256: "A".repeat(64),
      },
      {
        artifactId: crypto.randomUUID(),
        role: "manifest" as const,
        artifactName: "manifest.json",
        mediaType: "application/json",
        byteLength: 100,
        sha256: "B".repeat(64),
      },
      {
        artifactId: crypto.randomUUID(),
        role: "validation" as const,
        artifactName: "validation.json",
        mediaType: "application/json",
        byteLength: 300,
        sha256: "C".repeat(64),
      },
    ];
    patchTasks.findArtifacts.mockResolvedValue(packageArtifacts);
    artifacts.authorizeRunArtifactDownload.mockResolvedValue({
      artifactId: packageArtifacts[2]?.artifactId,
      downloadUrl: "http://127.0.0.1:9000/download",
      expiresAtUtc: "2026-07-25T12:05:00.000Z",
    });

    await expect(
      service.authorizeArtifactDownload(runId, "validation", ownerUserId),
    ).resolves.toMatchObject({
      role: "validation",
      downloadUrl: "http://127.0.0.1:9000/download",
    });
    expect(patchTasks.findArtifacts).toHaveBeenCalledWith(runId, ownerUserId);
    expect(artifacts.authorizeRunArtifactDownload).toHaveBeenCalledWith(
      runId,
      packageArtifacts[2]?.artifactId,
      "validation.json",
    );
  });

  it("does not sign a partial Package artifact set", async () => {
    patchTasks.findArtifacts.mockResolvedValue(undefined);

    await expect(
      service.authorizeArtifactDownload(runId, "candidate", ownerUserId),
    ).rejects.toMatchObject({
      response: { code: "PATCH_TASK_ARTIFACTS_NOT_READY" },
    });
    expect(artifacts.authorizeRunArtifactDownload).not.toHaveBeenCalled();
  });
});
