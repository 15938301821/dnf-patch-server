import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  ObjectStorageError,
  type ObjectStoragePort,
} from "../../common/storage/object-storage.client.js";
import { OBJECT_STORAGE_PORT } from "../../common/storage/object-storage.tokens.js";
import type {
  ArtifactDownloadAuthorizationView,
  ArtifactUploadAuthorizationView,
  ArtifactView,
  AuthorizeArtifactDownloadInput,
  AuthorizeArtifactUploadInput,
  FinalizeArtifactUploadInput,
} from "./artifact.contracts.js";
import { ArtifactRepository } from "./artifact.repository.js";
import type {
  ArtifactRepositoryPort,
  ArtifactUploadMutationStatus,
  ReserveArtifactUploadRecord,
} from "./artifact.repository-contracts.js";
import {
  ARTIFACT_UPLOAD_OPTIONS,
  type ArtifactUploadOptions,
} from "./artifact.tokens.js";

const terminalVerificationCodes = new Set([
  "OBJECT_STORAGE_LENGTH_MISMATCH",
  "OBJECT_STORAGE_MEDIA_TYPE_MISMATCH",
  "OBJECT_STORAGE_OBJECT_TOO_LARGE",
  "OBJECT_STORAGE_SHA256_MISMATCH",
]);

@Injectable()
export class ArtifactService {
  constructor(
    @Inject(ArtifactRepository)
    private readonly artifacts: ArtifactRepositoryPort,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
    @Inject(ARTIFACT_UPLOAD_OPTIONS)
    private readonly options: ArtifactUploadOptions,
  ) {}

  findRunId(id: string): Promise<string | undefined> {
    return this.artifacts.findRunId(id);
  }

  listByRun(runId: string): Promise<ArtifactView[]> {
    return this.artifacts.listByRun(runId);
  }

  /**
   * 为当前 Worker 租约预留服务端对象 key，并返回受声明长度、类型与哈希约束的短期 PUT。
   */
  async authorizeUpload(
    jobId: string,
    input: AuthorizeArtifactUploadInput,
  ): Promise<ArtifactUploadAuthorizationView> {
    const uploadId = randomUUID();
    const objectKey = `artifacts/${randomUUID()}`;
    const record: ReserveArtifactUploadRecord = {
      id: uploadId,
      objectKey,
      logicalName: input.logicalName,
      mediaType: input.mediaType,
      expectedByteLength: input.byteLength,
      expectedSha256: input.sha256.toUpperCase(),
      provenance: input.provenance,
    };
    const reserved = await this.artifacts.reserveUpload(
      jobId,
      record,
      leaseInput(input),
      this.options.sessionTtlSeconds,
      this.options.maxRunBytes,
    );
    if (reserved.status !== "accepted") {
      throwUploadMutation(reserved.status);
    }
    try {
      const authorization = await this.storage.authorizeUpload({
        objectKey: reserved.session.objectKey,
        mediaType: reserved.session.mediaType,
        byteLength: reserved.session.expectedByteLength,
        sha256: reserved.session.expectedSha256,
      });
      return {
        uploadId: reserved.session.id,
        uploadUrl: authorization.url,
        requiredHeaders: authorization.requiredHeaders,
        expiresAtUtc: reserved.session.expiresAt.toISOString(),
      };
    } catch {
      await this.artifacts.rejectUpload(
        reserved.session.id,
        "OBJECT_STORAGE_AUTHORIZATION_FAILED",
      );
      throw new ServiceUnavailableException({
        code: "OBJECT_STORAGE_AUTHORIZATION_FAILED",
        message: "对象上传授权暂时不可用。",
      });
    }
  }

  /**
   * 再次验证 Worker 租约并流式复核对象；只有复核证据通过后才创建最终 Artifact。
   */
  async finalizeUpload(
    jobId: string,
    uploadId: string,
    input: FinalizeArtifactUploadInput,
  ): Promise<ArtifactView> {
    const prepared = await this.artifacts.prepareFinalize(
      jobId,
      uploadId,
      input,
    );
    if (prepared.status === "finalized") return prepared.artifact;
    if (prepared.status !== "accepted") {
      throwUploadMutation(prepared.status);
    }
    let evidence;
    try {
      evidence = await this.storage.verify({
        objectKey: prepared.session.objectKey,
        expectedMediaType: prepared.session.mediaType,
        expectedByteLength: prepared.session.expectedByteLength,
        expectedSha256: prepared.session.expectedSha256,
      });
    } catch (error) {
      await this.rejectInvalidObject(prepared.session.id, error);
      throwStorageFailure(error);
    }
    const finalized = await this.artifacts.finalizeUpload(
      jobId,
      prepared.session.id,
      randomUUID(),
      evidence,
      input,
    );
    if (finalized.status === "accepted" || finalized.status === "finalized") {
      return finalized.artifact;
    }
    if (finalized.status === "evidence-mismatch") {
      await this.deleteRejectedObject(
        prepared.session.id,
        prepared.session.objectKey,
      );
    }
    throwUploadMutation(finalized.status);
  }

  /** 为当前有效租约签发同 Run 最终 Artifact 的短期 GET，不返回对象 key。 */
  async authorizeDownload(
    jobId: string,
    artifactId: string,
    input: AuthorizeArtifactDownloadInput,
  ): Promise<ArtifactDownloadAuthorizationView> {
    const found = await this.artifacts.findForDownload(
      jobId,
      artifactId,
      input,
    );
    if (found.status === "artifact-not-found") {
      throw new NotFoundException({
        code: "ARTIFACT_NOT_FOUND",
        message: "Artifact 不存在或不属于当前 Run。",
      });
    }
    if (found.status !== "accepted") throwUploadMutation(found.status);
    const authorization = await this.storage.authorizeDownload({
      objectKey: found.objectKey,
    });
    return {
      artifactId,
      downloadUrl: authorization.url,
      expiresAtUtc: authorization.expiresAtUtc,
    };
  }

  private async rejectInvalidObject(
    uploadId: string,
    error: unknown,
  ): Promise<void> {
    const code = objectStorageErrorCode(error);
    if (!code || !terminalVerificationCodes.has(code)) return;
    const objectKey = await this.artifacts.rejectUpload(uploadId, code);
    if (!objectKey) return;
    await this.deleteRejectedObject(uploadId, objectKey);
  }

  private async deleteRejectedObject(
    uploadId: string,
    objectKey: string,
  ): Promise<void> {
    try {
      await this.storage.delete({ objectKey });
      await this.artifacts.markObjectDeleted(uploadId);
    } catch {
      // Rejected sessions remain available to the bounded orphan reaper.
    }
  }

  /** 删除已拒绝或过期会话对象；失败项保留，供下一有界批次重试。 */
  async reapOrphans(batchSize: number): Promise<void> {
    const orphans = await this.artifacts.findOrphans(batchSize);
    for (const orphan of orphans) {
      try {
        await this.storage.delete({ objectKey: orphan.objectKey });
        await this.artifacts.markObjectDeleted(orphan.uploadId);
      } catch {
        // 单个对象失败不能阻断同一批次的其余清理。
      }
    }
  }
}

function leaseInput(
  input: AuthorizeArtifactUploadInput,
): FinalizeArtifactUploadInput {
  return {
    workerId: input.workerId,
    leaseId: input.leaseId,
    attempt: input.attempt,
  };
}

function objectStorageErrorCode(error: unknown): string | undefined {
  if (error instanceof ObjectStorageError) return error.code;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function throwStorageFailure(error: unknown): never {
  const code = objectStorageErrorCode(error);
  if (code && terminalVerificationCodes.has(code)) {
    throw new ConflictException({
      code,
      message: "上传对象与声明证据不一致。",
    });
  }
  throw new ServiceUnavailableException({
    code: "OBJECT_STORAGE_VERIFICATION_UNAVAILABLE",
    message: "对象完整性复核暂时不可用。",
  });
}

function throwUploadMutation(status: ArtifactUploadMutationStatus): never {
  if (status === "run-quota-exceeded") {
    throw new PayloadTooLargeException({
      code: "ARTIFACT_RUN_QUOTA_EXCEEDED",
      message: "当前 Run 的对象容量配额不足。",
    });
  }
  if (status === "upload-not-found") {
    throw new NotFoundException({
      code: "ARTIFACT_UPLOAD_NOT_FOUND",
      message: "Artifact 上传会话不存在。",
    });
  }
  throw new ConflictException({
    code:
      status === "lease-mismatch"
        ? "JOB_LEASE_MISMATCH"
        : status === "upload-expired"
          ? "ARTIFACT_UPLOAD_EXPIRED"
          : status === "evidence-mismatch"
            ? "ARTIFACT_EVIDENCE_MISMATCH"
            : "ARTIFACT_UPLOAD_TERMINAL",
    message: "Artifact 上传会话状态或 Worker 租约不允许当前操作。",
  });
}
