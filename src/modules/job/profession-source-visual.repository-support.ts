/**
 * @fileoverview 在 Profession 模型预约事务内验证官方源图 Artifact 与 finalized upload session；
 * 不创建执行、不读取对象正文，也不接受 Artifact ID 代替同 attempt 来源证明。
 * @module modules/job
 */
import { and, eq } from "drizzle-orm";
import type { DatabaseService } from "../../common/db/database.service.js";
import { artifactUploadSessions } from "../../common/db/artifact-schema.js";
import { artifacts } from "../../common/db/schema.js";
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import {
  professionSourceVisualInputProvenanceSchema,
  type RequestProfessionSkillExecutionInput,
} from "./profession-execution.contracts.js";
import type { VerifiedProfessionSourceVisualInput } from "./profession-model-execution.js";

type ProfessionTransaction = Parameters<
  Parameters<DatabaseService["database"]["transaction"]>[0]
>[0];

/** 只接受当前模型请求声明且由同一 Job attempt finalize 的唯一官方源图集。 */
export async function resolveSourceVisualInput(
  transaction: ProfessionTransaction,
  jobId: string,
  input: RequestProfessionSkillExecutionInput,
  runId: string,
  frameManifestArtifactId: string,
): Promise<VerifiedProfessionSourceVisualInput | undefined> {
  const rows = await transaction
    .select({
      artifactId: artifacts.id,
      artifactStorageKey: artifacts.storageKey,
      artifactLogicalName: artifacts.logicalName,
      artifactMediaType: artifacts.mediaType,
      artifactByteLength: artifacts.byteLength,
      artifactSha256: artifacts.sha256,
      artifactProvenance: artifacts.provenance,
      sessionObjectKey: artifactUploadSessions.objectKey,
      sessionLogicalName: artifactUploadSessions.logicalName,
      sessionMediaType: artifactUploadSessions.mediaType,
      sessionByteLength: artifactUploadSessions.expectedByteLength,
      sessionSha256: artifactUploadSessions.expectedSha256,
      sessionProvenance: artifactUploadSessions.provenance,
    })
    .from(artifactUploadSessions)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.runId, artifactUploadSessions.runId),
        eq(artifacts.id, artifactUploadSessions.artifactId),
      ),
    )
    .where(
      and(
        eq(artifactUploadSessions.runId, runId),
        eq(artifactUploadSessions.jobId, jobId),
        eq(artifactUploadSessions.workerId, input.workerId),
        eq(artifactUploadSessions.leaseId, input.leaseId),
        eq(artifactUploadSessions.attempt, input.attempt),
        eq(artifactUploadSessions.status, "finalized"),
        eq(
          artifactUploadSessions.artifactId,
          input.sourceVisualInput.artifactId,
        ),
        eq(
          artifactUploadSessions.logicalName,
          "profession-source-visual-input.png",
        ),
        eq(artifactUploadSessions.mediaType, "image/png"),
      ),
    )
    .limit(2);
  if (rows.length !== 1) return undefined;
  const row = rows[0];
  if (!row) return undefined;
  const sessionProvenance =
    professionSourceVisualInputProvenanceSchema.safeParse(
      row.sessionProvenance,
    );
  const artifactProvenance =
    professionSourceVisualInputProvenanceSchema.safeParse(
      row.artifactProvenance,
    );
  if (
    !sessionProvenance.success ||
    !artifactProvenance.success ||
    sha256JcsV1(sessionProvenance.data) !==
      sha256JcsV1(artifactProvenance.data) ||
    row.artifactStorageKey !== row.sessionObjectKey ||
    row.artifactLogicalName !== row.sessionLogicalName ||
    row.artifactMediaType !== row.sessionMediaType ||
    row.artifactByteLength !== row.sessionByteLength ||
    row.artifactSha256.toUpperCase() !== row.sessionSha256.toUpperCase() ||
    row.artifactByteLength !== input.sourceVisualInput.byteLength ||
    row.artifactSha256.toUpperCase() !== input.sourceVisualInput.sha256 ||
    sessionProvenance.data.jobId !== jobId ||
    sessionProvenance.data.runId !== runId ||
    sessionProvenance.data.attempt !== input.attempt ||
    sessionProvenance.data.skillId !== input.skillId ||
    sessionProvenance.data.frameManifestArtifactId !==
      frameManifestArtifactId ||
    sessionProvenance.data.frameMapSha256 !==
      input.sourceVisualInput.frameMapSha256
  ) {
    return undefined;
  }
  return {
    artifactId: row.artifactId,
    objectKey: row.artifactStorageKey,
    mediaType: "image/png",
    byteLength: row.artifactByteLength,
    sha256: row.artifactSha256.toUpperCase(),
    frameMapSha256: sessionProvenance.data.frameMapSha256,
  };
}
