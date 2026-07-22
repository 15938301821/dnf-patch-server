/**
 * @fileoverview 验证 Worker 租约绑定的 Artifact 上传会话与可信 finalize；不连接 MySQL 或 MinIO。
 * @module artifact
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type {
  ObjectStorageEvidence,
  ObjectStoragePort,
  ObjectStorageUploadRequest,
} from "../../common/storage/object-storage.client.js";
import type {
  ArtifactRepositoryPort,
  ArtifactUploadSessionRecord,
} from "./artifact.repository-contracts.js";
import { ArtifactService } from "./artifact.service.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const workerId = "33333333-3333-4333-8333-333333333333";
const leaseId = "44444444-4444-4444-8444-444444444444";
const uploadId = "55555555-5555-4555-8555-555555555555";
const artifactId = "66666666-6666-4666-8666-666666666666";
const sha256 = "A".repeat(64);

const uploadInput = {
  workerId,
  leaseId,
  attempt: 1,
  logicalName: "candidate.npk",
  mediaType: "application/octet-stream",
  byteLength: 8,
  sha256,
  provenance: { kind: "candidate-package" },
};

function session(
  overrides: Partial<ArtifactUploadSessionRecord> = {},
): ArtifactUploadSessionRecord {
  return {
    id: uploadId,
    runId,
    jobId,
    workerId,
    leaseId,
    attempt: 1,
    objectKey: `artifacts/${uploadId}`,
    logicalName: uploadInput.logicalName,
    mediaType: uploadInput.mediaType,
    expectedByteLength: uploadInput.byteLength,
    expectedSha256: sha256,
    provenance: uploadInput.provenance,
    status: "authorized",
    expiresAt: new Date("2026-07-22T12:05:00.000Z"),
    createdAt: new Date("2026-07-22T12:00:00.000Z"),
    ...overrides,
  };
}

function repositoryStub(
  overrides: Partial<ArtifactRepositoryPort> = {},
): ArtifactRepositoryPort {
  return {
    findRunId: vi.fn().mockResolvedValue(undefined),
    listByRun: vi.fn().mockResolvedValue([]),
    reserveUpload: vi.fn().mockResolvedValue({
      status: "accepted",
      session: session(),
    }),
    prepareFinalize: vi.fn().mockResolvedValue({
      status: "accepted",
      session: session(),
    }),
    finalizeUpload: vi.fn().mockResolvedValue({
      status: "accepted",
      artifact: {
        id: artifactId,
        runId,
        logicalName: uploadInput.logicalName,
        mediaType: uploadInput.mediaType,
        byteLength: uploadInput.byteLength,
        sha256,
        provenance: uploadInput.provenance,
        createdAtUtc: "2026-07-22T12:01:00.000Z",
      },
    }),
    rejectUpload: vi.fn().mockResolvedValue(`artifacts/${uploadId}`),
    findForDownload: vi.fn().mockResolvedValue({
      status: "artifact-not-found",
    }),
    findOrphans: vi.fn().mockResolvedValue([]),
    markObjectDeleted: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function storageStub(
  overrides: Partial<ObjectStoragePort> = {},
): ObjectStoragePort {
  return {
    authorizeUpload: vi.fn().mockResolvedValue({
      objectKey: `artifacts/${uploadId}`,
      url: "http://127.0.0.1:9000/upload",
      requiredHeaders: {
        "content-type": "application/octet-stream",
        "if-none-match": "*",
      },
      expiresAtUtc: "2026-07-22T12:05:00.000Z",
    }),
    authorizeDownload: vi.fn().mockRejectedValue(new Error("not used")),
    verify: vi.fn().mockResolvedValue({
      objectKey: `artifacts/${uploadId}`,
      mediaType: "application/octet-stream",
      byteLength: 8,
      sha256,
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ArtifactService upload lifecycle", () => {
  it("generates the object key and returns no bucket choice", async () => {
    let authorizedInput: ObjectStorageUploadRequest | undefined;
    const authorizeUpload = vi.fn((input: ObjectStorageUploadRequest) => {
      authorizedInput = input;
      return Promise.resolve({
        objectKey: input.objectKey,
        url: "http://127.0.0.1:9000/upload",
        requiredHeaders: { "if-none-match": "*" },
        expiresAtUtc: "2026-07-22T12:05:00.000Z",
      });
    });
    const artifacts = repositoryStub();
    const service = new ArtifactService(
      artifacts,
      storageStub({ authorizeUpload }),
      { maxRunBytes: 10_737_418_240, sessionTtlSeconds: 300 },
    );

    const result = await service.authorizeUpload(jobId, uploadInput);

    expect(result.uploadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.uploadUrl).toBe("http://127.0.0.1:9000/upload");
    expect(result.requiredHeaders).toEqual({ "if-none-match": "*" });
    expect(result).not.toHaveProperty("objectKey");
    expect(result).not.toHaveProperty("bucket");
    expect(authorizedInput).toBeDefined();
    if (!authorizedInput) throw new Error("UPLOAD_AUTHORIZATION_NOT_REQUESTED");
    expect(authorizedInput.objectKey).toMatch(/^artifacts\/[0-9a-f-]{36}$/u);
    expect(authorizedInput.byteLength).toBe(8);
    expect(authorizedInput.sha256).toBe(sha256);
  });

  it("does not return an upload URL when the lease reservation is rejected", async () => {
    const artifacts = repositoryStub({
      reserveUpload: vi.fn().mockResolvedValue({ status: "lease-mismatch" }),
    });
    const service = new ArtifactService(artifacts, storageStub(), {
      maxRunBytes: 10_737_418_240,
      sessionTtlSeconds: 300,
    });

    await expect(service.authorizeUpload(jobId, uploadInput)).rejects.toThrow(
      ConflictException,
    );
  });

  it("never creates final metadata when object verification fails", async () => {
    const finalizeUpload = vi.fn<ArtifactRepositoryPort["finalizeUpload"]>();
    const rejectUpload = vi
      .fn<ArtifactRepositoryPort["rejectUpload"]>()
      .mockResolvedValue(`artifacts/${uploadId}`);
    const markObjectDeleted = vi
      .fn<ArtifactRepositoryPort["markObjectDeleted"]>()
      .mockResolvedValue(undefined);
    const artifacts = repositoryStub({
      finalizeUpload,
      rejectUpload,
      markObjectDeleted,
    });
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const service = new ArtifactService(
      artifacts,
      storageStub({
        verify: vi.fn().mockRejectedValue(
          Object.assign(new Error("mismatch"), {
            code: "OBJECT_STORAGE_SHA256_MISMATCH",
          }),
        ),
        delete: deleteObject,
      }),
      { maxRunBytes: 10_737_418_240, sessionTtlSeconds: 300 },
    );

    await expect(
      service.finalizeUpload(jobId, uploadId, {
        workerId,
        leaseId,
        attempt: 1,
      }),
    ).rejects.toBeDefined();
    expect(finalizeUpload).not.toHaveBeenCalled();
    expect(rejectUpload).toHaveBeenCalledWith(
      uploadId,
      "OBJECT_STORAGE_SHA256_MISMATCH",
    );
    expect(deleteObject).toHaveBeenCalledWith({
      objectKey: `artifacts/${uploadId}`,
    });
    expect(markObjectDeleted).toHaveBeenCalledWith(uploadId);
  });

  it("cleans an object rejected by the transactional evidence check", async () => {
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const markObjectDeleted = vi
      .fn<ArtifactRepositoryPort["markObjectDeleted"]>()
      .mockResolvedValue(undefined);
    const artifacts = repositoryStub({
      finalizeUpload: vi.fn().mockResolvedValue({
        status: "evidence-mismatch",
      }),
      markObjectDeleted,
    });
    const service = new ArtifactService(
      artifacts,
      storageStub({ delete: deleteObject }),
      { maxRunBytes: 10_737_418_240, sessionTtlSeconds: 300 },
    );

    await expect(
      service.finalizeUpload(jobId, uploadId, {
        workerId,
        leaseId,
        attempt: 1,
      }),
    ).rejects.toThrow(ConflictException);
    expect(deleteObject).toHaveBeenCalledWith({
      objectKey: `artifacts/${uploadId}`,
    });
    expect(markObjectDeleted).toHaveBeenCalledWith(uploadId);
  });

  it("continues an orphan batch when one object deletion fails", async () => {
    const secondUploadId = "77777777-7777-4777-8777-777777777777";
    const markObjectDeleted = vi
      .fn<ArtifactRepositoryPort["markObjectDeleted"]>()
      .mockResolvedValue(undefined);
    const deleteObject = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValueOnce(undefined);
    const artifacts = repositoryStub({
      findOrphans: vi.fn().mockResolvedValue([
        { uploadId, objectKey: `artifacts/${uploadId}` },
        {
          uploadId: secondUploadId,
          objectKey: `artifacts/${secondUploadId}`,
        },
      ]),
      markObjectDeleted,
    });
    const service = new ArtifactService(
      artifacts,
      storageStub({ delete: deleteObject }),
      { maxRunBytes: 10_737_418_240, sessionTtlSeconds: 300 },
    );

    await service.reapOrphans(2);

    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(markObjectDeleted).toHaveBeenCalledOnce();
    expect(markObjectDeleted).toHaveBeenCalledWith(secondUploadId);
  });

  it("persists only evidence recomputed from object storage", async () => {
    const evidence: ObjectStorageEvidence = {
      objectKey: `artifacts/${uploadId}`,
      mediaType: "application/octet-stream",
      byteLength: 8,
      sha256,
    };
    const finalizeUpload = vi.fn(
      (
        _jobId: string,
        _sessionId: string,
        _artifactId: string,
        actual: ObjectStorageEvidence,
      ) =>
        Promise.resolve({
          status: "accepted" as const,
          artifact: {
            id: artifactId,
            runId,
            logicalName: uploadInput.logicalName,
            mediaType: actual.mediaType,
            byteLength: actual.byteLength,
            sha256: actual.sha256,
            provenance: uploadInput.provenance,
            createdAtUtc: "2026-07-22T12:01:00.000Z",
          },
        }),
    );
    const service = new ArtifactService(
      repositoryStub({ finalizeUpload }),
      storageStub({ verify: vi.fn().mockResolvedValue(evidence) }),
      { maxRunBytes: 10_737_418_240, sessionTtlSeconds: 300 },
    );

    const artifact = await service.finalizeUpload(jobId, uploadId, {
      workerId,
      leaseId,
      attempt: 1,
    });

    expect(artifact.id).toBe(artifactId);
    expect(finalizeUpload).toHaveBeenCalledWith(
      jobId,
      uploadId,
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
      evidence,
      { workerId, leaseId, attempt: 1 },
    );
  });
});
