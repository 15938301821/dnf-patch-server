/**
 * @fileoverview 复核 Profession 单技能 passed 报告引用的 finalized Artifact 上传证据。
 *
 * 调用关系：单技能证据解析器在同一个数据库事务中依次调用本模块；输入是服务端恢复的 Run、
 * 当前 Worker lease、Artifact ID 与严格 provenance，输出只包含后续 production 写入需要的上传
 * 绑定。副作用仅为 transaction 内的数据库读取和行锁，不读取对象正文、不更新生产状态。
 * 安全边界：上传会话与 Artifact 两侧的 Run、Job、lease、attempt、元数据和 provenance 必须完全
 * 一致；任一漂移返回 undefined，调用方不得把技能标记为 passed。
 */
import { and, eq } from "drizzle-orm";
import { artifactUploadSessions } from "../../common/db/artifact-schema.js";
import type { DatabaseService } from "../../common/db/database.service.js";
import { artifacts } from "../../common/db/schema.js";
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import type { ReportPatchTaskSkillProductionInput } from "./patch-task.contracts.js";
import {
  professionSkillOutputProvenanceSchema,
  type ProfessionSkillOutputProvenance,
} from "./profession-skill-output-evidence.js";

type Transaction = Parameters<
  Parameters<DatabaseService["database"]["transaction"]>[0]
>[0];
type PassedReport = Extract<
  ReportPatchTaskSkillProductionInput,
  { status: "passed" }
>;

/** 已锁定并通过双侧复核的上传绑定；不包含对象 key 或临时授权。 */
export interface FinalizedOutputArtifact {
  uploadId: string;
  artifactId: string;
  sha256: string;
}

/**
 * 锁定 Artifact 对应的唯一 finalized 会话，并核对当前 lease、对象元数据和固定 provenance。
 *
 * @param transaction 调用方已经持有 Job 与 production 锁的同一事务。
 * @param jobId 当前 Profession Job ID，只能来自服务端锁定记录。
 * @param runId 当前 producing Run ID。
 * @param input 已通过严格 DTO 校验的当前 passed 报告。
 * @param artifactId Worker 声明的固定角色 Artifact ID。
 * @param expectedProvenance 服务端从模型、来源与前置 Artifact 独立恢复的期望证据。
 * @param expectedMediaType 固定角色媒体类型；双 ZIP 默认 application/zip，预览必须显式 image/png。
 * @returns 全部证据一致时返回上传绑定，否则返回 undefined 且禁止终态写入。
 */
export async function lockedFinalizedOutputArtifact(
  transaction: Transaction,
  jobId: string,
  runId: string,
  input: PassedReport,
  artifactId: string,
  expectedProvenance: ProfessionSkillOutputProvenance,
  expectedMediaType: "application/zip" | "image/png" = "application/zip",
): Promise<FinalizedOutputArtifact | undefined> {
  const [row] = await transaction
    .select({
      uploadId: artifactUploadSessions.id,
      sessionRunId: artifactUploadSessions.runId,
      sessionJobId: artifactUploadSessions.jobId,
      workerId: artifactUploadSessions.workerId,
      leaseId: artifactUploadSessions.leaseId,
      attempt: artifactUploadSessions.attempt,
      objectKey: artifactUploadSessions.objectKey,
      sessionLogicalName: artifactUploadSessions.logicalName,
      sessionMediaType: artifactUploadSessions.mediaType,
      expectedByteLength: artifactUploadSessions.expectedByteLength,
      expectedSha256: artifactUploadSessions.expectedSha256,
      sessionProvenance: artifactUploadSessions.provenance,
      sessionStatus: artifactUploadSessions.status,
      sessionArtifactId: artifactUploadSessions.artifactId,
      finalizedAt: artifactUploadSessions.finalizedAt,
      objectDeletedAt: artifactUploadSessions.objectDeletedAt,
      artifactId: artifacts.id,
      artifactRunId: artifacts.runId,
      storageKey: artifacts.storageKey,
      artifactLogicalName: artifacts.logicalName,
      artifactMediaType: artifacts.mediaType,
      artifactByteLength: artifacts.byteLength,
      artifactSha256: artifacts.sha256,
      artifactProvenance: artifacts.provenance,
    })
    .from(artifactUploadSessions)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.runId, artifactUploadSessions.runId),
        eq(artifacts.id, artifactUploadSessions.artifactId),
      ),
    )
    .where(eq(artifactUploadSessions.artifactId, artifactId))
    .limit(1)
    .for("update");
  const sessionProvenance = professionSkillOutputProvenanceSchema.safeParse(
    row?.sessionProvenance,
  );
  const artifactProvenance = professionSkillOutputProvenanceSchema.safeParse(
    row?.artifactProvenance,
  );
  const expected =
    professionSkillOutputProvenanceSchema.safeParse(expectedProvenance);
  if (
    !row ||
    !sessionProvenance.success ||
    !artifactProvenance.success ||
    !expected.success ||
    row.sessionRunId !== runId ||
    row.artifactRunId !== runId ||
    row.sessionJobId !== jobId ||
    row.workerId !== input.workerId ||
    row.leaseId !== input.leaseId ||
    row.attempt !== input.attempt ||
    row.sessionStatus !== "finalized" ||
    row.sessionArtifactId !== artifactId ||
    row.artifactId !== artifactId ||
    row.finalizedAt === null ||
    row.objectDeletedAt !== null ||
    row.objectKey !== row.storageKey ||
    row.sessionLogicalName !== row.artifactLogicalName ||
    row.sessionMediaType !== expectedMediaType ||
    row.artifactMediaType !== expectedMediaType ||
    row.expectedByteLength <= 0 ||
    row.expectedByteLength !== row.artifactByteLength ||
    row.expectedSha256.toUpperCase() !== row.artifactSha256.toUpperCase() ||
    sha256JcsV1(sessionProvenance.data) !== sha256JcsV1(expected.data) ||
    sha256JcsV1(artifactProvenance.data) !== sha256JcsV1(expected.data)
  ) {
    return undefined;
  }
  return {
    uploadId: row.uploadId,
    artifactId: row.artifactId,
    sha256: row.artifactSha256.toUpperCase(),
  };
}

/**
 * 从 Artifact 与上传会话联合读取完全一致的严格 provenance。
 * @param transaction 当前 passed 接收事务，查询会锁定目标上传会话。
 * @param artifactId 固定预览角色的 Artifact ID。
 * @returns 双侧结构和摘要一致时返回解析后的证据，否则返回 undefined。
 */
export async function resolveOutputProvenance(
  transaction: Transaction,
  artifactId: string,
): Promise<ProfessionSkillOutputProvenance | undefined> {
  const [row] = await transaction
    .select({
      artifactProvenance: artifacts.provenance,
      sessionProvenance: artifactUploadSessions.provenance,
    })
    .from(artifactUploadSessions)
    .innerJoin(artifacts, eq(artifacts.id, artifactUploadSessions.artifactId))
    .where(eq(artifactUploadSessions.artifactId, artifactId))
    .limit(1)
    .for("update");
  const artifactProvenance = professionSkillOutputProvenanceSchema.safeParse(
    row?.artifactProvenance,
  );
  const sessionProvenance = professionSkillOutputProvenanceSchema.safeParse(
    row?.sessionProvenance,
  );
  return artifactProvenance.success &&
    sessionProvenance.success &&
    sha256JcsV1(artifactProvenance.data) === sha256JcsV1(sessionProvenance.data)
    ? artifactProvenance.data
    : undefined;
}
