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
  productionContractVersion: 5 | 6;
  professionId: string;
  styleId: string;
  jobId: string;
  workerId: string;
  leaseId: string;
  attempt: number;
  sourceRunId: string;
  sourceFrameManifestArtifactId: string;
  promptSha256: string;
  imageAttemptId: string | null;
  targetFrameManifestArtifactId: string | null;
  targetFrameManifestSha256: string | null;
  targetSetSha256: string | null;
  targetFrameCount: number | null;
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

/** 由同一 producing lease 的 Production 与 Artifact 行构造 finalized upload 会话 fixture。 */
export function createOutputUploadFixture(
  runId: string,
  production: ProductionFixture | undefined,
  artifact: ArtifactFixture | undefined,
  id: string,
): UploadFixture {
  if (!production || !artifact) {
    throw new Error("TEST_OUTPUT_EVIDENCE_REQUIRED");
  }
  return {
    id,
    runId,
    jobId: production.jobId,
    workerId: production.workerId,
    leaseId: production.leaseId,
    attempt: production.attempt,
    objectKey: artifact.storageKey,
    logicalName: artifact.logicalName,
    mediaType: artifact.mediaType,
    expectedByteLength: artifact.byteLength,
    expectedSha256: artifact.sha256,
    provenance: artifact.provenance,
    status: "finalized",
    artifactId: artifact.id,
    finalizedAt: new Date("2026-07-24T00:04:00.000Z"),
    objectDeletedAt: null,
  };
}
