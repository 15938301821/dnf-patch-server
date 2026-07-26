/**
 * @fileoverview 定义 StylePackageContextRepository 单测使用的持久化边界 fixture 类型。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-26
 * @relatedPlan N/A - Package V3 context Repository 测试规模收口
 */

export interface ArtifactFixture {
  id: string;
  runId: string;
  storageKey: string;
  logicalName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  provenance: unknown;
}

export interface ProductionFixture {
  skillId: string;
  professionId: string;
  styleId: string;
  jobId: string;
  workerId: string;
  leaseId: string;
  attempt: number;
  sourceRunId: string;
  sourceFrameManifestArtifactId: string;
  promptSha256: string;
  imageAttemptId: string;
  asepriteProfileId: string;
  asepriteBinarySha256: string;
  asepriteAdapterSha256: string;
  asepriteArtifactId: string;
  asepriteUploadId: string;
  validationArtifactId: string;
  validationUploadId: string;
  status: string;
  errorCode: null;
  finishedAt: Date;
}

export interface UploadFixture {
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
  provenance: unknown;
  status: string;
  artifactId: string;
  finalizedAt: Date;
  objectDeletedAt: null;
}
