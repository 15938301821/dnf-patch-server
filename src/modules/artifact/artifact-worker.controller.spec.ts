/**
 * @fileoverview 验证 Artifact Worker HTTP 边界的守卫与参数委托；不覆盖 Service 或对象存储实现。
 * @module artifact
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import type {
  ArtifactDownloadAuthorizationView,
  ArtifactUploadAuthorizationView,
  ArtifactView,
} from "./artifact.contracts.js";
import type { ArtifactService } from "./artifact.service.js";
import { ArtifactWorkerController } from "./artifact-worker.controller.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const uploadId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const workerId = "44444444-4444-4444-8444-444444444444";
const leaseId = "55555555-5555-4555-8555-555555555555";
const lease = { workerId, leaseId, attempt: 1 };

describe("ArtifactWorkerController", () => {
  const authorizeUpload = vi.fn();
  const finalizeUpload = vi.fn();
  const authorizeDownload = vi.fn();
  let controller: ArtifactWorkerController;

  beforeEach(() => {
    vi.resetAllMocks();
    controller = new ArtifactWorkerController({
      authorizeUpload,
      finalizeUpload,
      authorizeDownload,
    } as unknown as ArtifactService);
  });

  it("requires the Worker token guard for every route", () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ArtifactWorkerController,
    ) as unknown[] | undefined;

    expect(guards).toContain(WorkerTokenGuard);
  });

  it("delegates upload authorization without adding storage choices", async () => {
    const input = {
      ...lease,
      logicalName: "candidate.npk",
      mediaType: "application/octet-stream",
      byteLength: 8,
      sha256: "A".repeat(64),
      provenance: { kind: "candidate-package" },
    };
    const view: ArtifactUploadAuthorizationView = {
      uploadId,
      uploadUrl: "http://127.0.0.1:9000/upload",
      requiredHeaders: { "if-none-match": "*" },
      expiresAtUtc: "2026-07-22T12:05:00.000Z",
    };
    authorizeUpload.mockResolvedValue(view);

    await expect(controller.authorizeUpload(jobId, input)).resolves.toEqual(
      view,
    );
    expect(authorizeUpload).toHaveBeenCalledWith(jobId, input);
    expect(view).not.toHaveProperty("bucket");
    expect(view).not.toHaveProperty("objectKey");
  });

  it("delegates finalize and download authorization with exact ids", async () => {
    const artifact: ArtifactView = {
      id: artifactId,
      runId: "66666666-6666-4666-8666-666666666666",
      logicalName: "candidate.npk",
      mediaType: "application/octet-stream",
      byteLength: 8,
      sha256: "A".repeat(64),
      provenance: { kind: "candidate-package" },
      createdAtUtc: "2026-07-22T12:01:00.000Z",
    };
    const download: ArtifactDownloadAuthorizationView = {
      artifactId,
      downloadUrl: "http://127.0.0.1:9000/download",
      expiresAtUtc: "2026-07-22T12:05:00.000Z",
    };
    finalizeUpload.mockResolvedValue(artifact);
    authorizeDownload.mockResolvedValue(download);

    await expect(
      controller.finalizeUpload(jobId, uploadId, lease),
    ).resolves.toEqual(artifact);
    await expect(
      controller.authorizeDownload(jobId, artifactId, lease),
    ).resolves.toEqual(download);
    expect(finalizeUpload).toHaveBeenCalledWith(jobId, uploadId, lease);
    expect(authorizeDownload).toHaveBeenCalledWith(jobId, artifactId, lease);
  });
});
