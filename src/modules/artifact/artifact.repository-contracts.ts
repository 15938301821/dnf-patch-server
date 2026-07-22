/**
 * @fileoverview 定义 Artifact 上传会话仓储契约；不包含 Drizzle、HTTP 或对象存储实现。
 * @module artifact
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import type { ObjectStorageEvidence } from "../../common/storage/object-storage.client.js";
import { z } from "zod";
import type {
  ArtifactView,
  FinalizeArtifactUploadInput,
} from "./artifact.contracts.js";

export const artifactUploadSessionStatusSchema = z.enum([
  "authorized",
  "finalized",
  "rejected",
]);
export type ArtifactUploadSessionStatus = z.infer<
  typeof artifactUploadSessionStatusSchema
>;

export interface ArtifactUploadSessionRecord {
  id: string;
  runId: string;
  jobId: string;
  workerId: string;
  leaseId: string;
  attempt: number;
  objectKey: string;
  logicalName: string;
  mediaType: string;
  expectedByteLength: number;
  expectedSha256: string;
  provenance: Record<string, unknown>;
  status: ArtifactUploadSessionStatus;
  expiresAt: Date;
  createdAt: Date;
  artifactId?: string;
}

export interface ReserveArtifactUploadRecord {
  id: string;
  objectKey: string;
  logicalName: string;
  mediaType: string;
  expectedByteLength: number;
  expectedSha256: string;
  provenance: Record<string, unknown>;
}

export type ArtifactUploadMutationStatus =
  | "accepted"
  | "finalized"
  | "lease-mismatch"
  | "run-quota-exceeded"
  | "upload-expired"
  | "upload-not-found"
  | "upload-terminal"
  | "evidence-mismatch";

export type ReserveArtifactUploadResult =
  | { status: "accepted"; session: ArtifactUploadSessionRecord }
  | { status: "lease-mismatch" | "run-quota-exceeded" };

export type PrepareArtifactFinalizeResult =
  | { status: "accepted"; session: ArtifactUploadSessionRecord }
  | { status: "finalized"; artifact: ArtifactView }
  | {
      status:
        | "lease-mismatch"
        | "upload-expired"
        | "upload-not-found"
        | "upload-terminal";
    };

export type FinalizeArtifactUploadResult =
  | { status: "accepted" | "finalized"; artifact: ArtifactView }
  | {
      status:
        | "evidence-mismatch"
        | "lease-mismatch"
        | "upload-expired"
        | "upload-not-found"
        | "upload-terminal";
    };

export type ArtifactDownloadLookupResult =
  | { status: "accepted"; objectKey: string }
  | { status: "artifact-not-found" | "lease-mismatch" };

export interface ArtifactOrphanRecord {
  uploadId: string;
  objectKey: string;
}

export interface ArtifactRepositoryPort {
  findRunId(id: string): Promise<string | undefined>;
  listByRun(runId: string): Promise<ArtifactView[]>;
  reserveUpload(
    jobId: string,
    reservation: ReserveArtifactUploadRecord,
    lease: FinalizeArtifactUploadInput,
    sessionTtlSeconds: number,
    maxRunBytes: number,
  ): Promise<ReserveArtifactUploadResult>;
  prepareFinalize(
    jobId: string,
    uploadId: string,
    lease: FinalizeArtifactUploadInput,
  ): Promise<PrepareArtifactFinalizeResult>;
  finalizeUpload(
    jobId: string,
    uploadId: string,
    artifactId: string,
    evidence: ObjectStorageEvidence,
    lease: FinalizeArtifactUploadInput,
  ): Promise<FinalizeArtifactUploadResult>;
  rejectUpload(
    uploadId: string,
    errorCode: string,
  ): Promise<string | undefined>;
  findForDownload(
    jobId: string,
    artifactId: string,
    lease: FinalizeArtifactUploadInput,
  ): Promise<ArtifactDownloadLookupResult>;
  findOrphans(batchSize: number): Promise<ArtifactOrphanRecord[]>;
  markObjectDeleted(uploadId: string): Promise<void>;
}
